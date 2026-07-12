/**
 * messaging-inbox-v2-media (Tanda 1 · B1.4) — InMemoryChatMessageAttachmentRepository.
 * TDD: exercises the `ChatMessageAttachmentRepository` port contract that
 * `ReceiveChatwootWebhook`/`DownloadChatMessageAttachment`/`ChatMediaDownloadScheduler`
 * depend on (spec MODEL-1, MEDIA-1/2/3, scenarios 1/2/11/12/13).
 */
import { InMemoryChatMessageAttachmentRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageAttachmentRepository';

function baseInput(overrides: Partial<Parameters<InMemoryChatMessageAttachmentRepository['upsertByChatwootAttachmentId']>[0]> = {}) {
  return {
    messageId: 'msg-1',
    chatwootAttachmentId: 42,
    fileType: 'image',
    contentType: 'image/jpeg',
    sourceUrl: 'https://chat.ipnext.com.ar/rails/active_storage/blobs/redirect/abc/photo.jpg',
    ...overrides,
  };
}

describe('InMemoryChatMessageAttachmentRepository', () => {
  describe('upsertByChatwootAttachmentId (scenario 1 — idempotencia)', () => {
    it('crea una fila pending en el primer upsert', async () => {
      const repo = new InMemoryChatMessageAttachmentRepository();
      const row = await repo.upsertByChatwootAttachmentId(baseInput());

      expect(row.status).toBe('pending');
      expect(row.chatwootAttachmentId).toBe(42);
      expect(row.storageKey).toBeNull();
      expect(row.downloadAttempts).toBe(0);
    });

    it('un segundo upsert con el MISMO chatwootAttachmentId NO duplica la fila', async () => {
      const repo = new InMemoryChatMessageAttachmentRepository();
      await repo.upsertByChatwootAttachmentId(baseInput());
      await repo.upsertByChatwootAttachmentId(baseInput({ contentType: 'image/png' }));

      const rows = await repo.listByMessageIds(['msg-1']);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.contentType).toBe('image/png'); // el segundo upsert SÍ actualiza metadata
    });
  });

  describe('upsertByChatwootAttachmentId (scenario 2 — reintento sobre downloaded no revierte)', () => {
    it('un upsert repetido sobre una fila YA downloaded NO la revierte a pending ni borra storageKey', async () => {
      const repo = new InMemoryChatMessageAttachmentRepository();
      const created = await repo.upsertByChatwootAttachmentId(baseInput());
      await repo.markDownloaded(created.id, { storageKey: 'messaging/conv-1/att-1.jpg' });

      const reprocessed = await repo.upsertByChatwootAttachmentId(baseInput());

      expect(reprocessed.status).toBe('downloaded');
      expect(reprocessed.storageKey).toBe('messaging/conv-1/att-1.jpg');
    });
  });

  describe('listByMessageIds (anti-N+1)', () => {
    it('devuelve SOLO las filas de los messageIds pedidos, ninguna de otros mensajes', async () => {
      const repo = new InMemoryChatMessageAttachmentRepository();
      await repo.upsertByChatwootAttachmentId(baseInput({ messageId: 'msg-1', chatwootAttachmentId: 1 }));
      await repo.upsertByChatwootAttachmentId(baseInput({ messageId: 'msg-2', chatwootAttachmentId: 2 }));
      await repo.upsertByChatwootAttachmentId(baseInput({ messageId: 'msg-3', chatwootAttachmentId: 3 }));

      const rows = await repo.listByMessageIds(['msg-1', 'msg-2']);
      expect(rows.map((r) => r.messageId).sort()).toEqual(['msg-1', 'msg-2']);
    });

    it('lista vacía de messageIds → []', async () => {
      const repo = new InMemoryChatMessageAttachmentRepository();
      await repo.upsertByChatwootAttachmentId(baseInput());
      expect(await repo.listByMessageIds([])).toEqual([]);
    });
  });

  describe('findById', () => {
    it('id inexistente → null', async () => {
      const repo = new InMemoryChatMessageAttachmentRepository();
      expect(await repo.findById('ghost')).toBeNull();
    });

    it('id existente → la fila', async () => {
      const repo = new InMemoryChatMessageAttachmentRepository();
      const created = await repo.upsertByChatwootAttachmentId(baseInput());
      const found = await repo.findById(created.id);
      expect(found?.chatwootAttachmentId).toBe(42);
    });
  });

  describe('markDownloaded / markFailed', () => {
    it('markDownloaded setea storageKey/thumbStorageKey y pasa a downloaded', async () => {
      const repo = new InMemoryChatMessageAttachmentRepository();
      const created = await repo.upsertByChatwootAttachmentId(baseInput());

      const updated = await repo.markDownloaded(created.id, {
        storageKey: 'messaging/conv-1/att-1.jpg',
        thumbStorageKey: 'messaging/conv-1/att-1-thumb.jpg',
      });

      expect(updated.status).toBe('downloaded');
      expect(updated.storageKey).toBe('messaging/conv-1/att-1.jpg');
      expect(updated.thumbStorageKey).toBe('messaging/conv-1/att-1-thumb.jpg');
    });

    it('markFailed incrementa downloadAttempts y setea lastError, pasa a failed', async () => {
      const repo = new InMemoryChatMessageAttachmentRepository();
      const created = await repo.upsertByChatwootAttachmentId(baseInput());

      const first = await repo.markFailed(created.id, { error: 'timeout' });
      expect(first.status).toBe('failed');
      expect(first.downloadAttempts).toBe(1);
      expect(first.lastError).toBe('timeout');

      const second = await repo.markFailed(created.id, { error: 'timeout again' });
      expect(second.downloadAttempts).toBe(2);
      expect(second.lastError).toBe('timeout again');
    });

    it('fix-be #2 (MEDIUM) — markFailed NUNCA pisa un downloaded ganado en carrera (fire-and-forget vs scheduler)', async () => {
      const repo = new InMemoryChatMessageAttachmentRepository();
      const created = await repo.upsertByChatwootAttachmentId(baseInput());

      // El fire-and-forget (web) gana la carrera y marca downloaded PRIMERO...
      await repo.markDownloaded(created.id, { storageKey: 'messaging/conv-1/att-1.jpg' });
      // ...pero el scheduler (u otra réplica), procesando el MISMO row concurrentemente,
      // todavía cree que falló y llama a markFailed DESPUÉS.
      const afterRace = await repo.markFailed(created.id, { error: 'timeout (stale attempt)' });

      expect(afterRace.status).toBe('downloaded'); // NO revertido a failed
      expect(afterRace.storageKey).toBe('messaging/conv-1/att-1.jpg'); // preservado
      expect(afterRace.downloadAttempts).toBe(0); // NO incrementado por el intento perdedor
      expect(afterRace.lastError).toBeNull(); // NO pisado por el error del perdedor

      const persisted = await repo.findById(created.id);
      expect(persisted!.status).toBe('downloaded');
      expect(persisted!.storageKey).toBe('messaging/conv-1/att-1.jpg');
    });
  });

  describe('listRetriable (scenario 11/12/13 — barrido del scheduler)', () => {
    it('incluye pending y failed con attempts por debajo del máximo', async () => {
      const repo = new InMemoryChatMessageAttachmentRepository();
      const pendingRow = await repo.upsertByChatwootAttachmentId(baseInput({ chatwootAttachmentId: 1 }));
      const failedRow = await repo.upsertByChatwootAttachmentId(baseInput({ chatwootAttachmentId: 2 }));
      await repo.markFailed(failedRow.id, { error: 'boom' });
      await repo.markFailed(failedRow.id, { error: 'boom' }); // attempts=2

      const retriable = await repo.listRetriable({ maxAttempts: 5 });
      const ids = retriable.map((r) => r.id).sort();
      expect(ids).toEqual([pendingRow.id, failedRow.id].sort());
    });

    it('excluye filas con downloadAttempts >= maxAttempts (abandono sin loop infinito)', async () => {
      const repo = new InMemoryChatMessageAttachmentRepository();
      const row = await repo.upsertByChatwootAttachmentId(baseInput());
      for (let i = 0; i < 5; i++) {
        await repo.markFailed(row.id, { error: `attempt ${i}` });
      }

      const retriable = await repo.listRetriable({ maxAttempts: 5 });
      expect(retriable.map((r) => r.id)).not.toContain(row.id);
    });

    it('excluye filas downloaded', async () => {
      const repo = new InMemoryChatMessageAttachmentRepository();
      const row = await repo.upsertByChatwootAttachmentId(baseInput());
      await repo.markDownloaded(row.id, { storageKey: 'k' });

      const retriable = await repo.listRetriable({ maxAttempts: 5 });
      expect(retriable.map((r) => r.id)).not.toContain(row.id);
    });
  });
});
