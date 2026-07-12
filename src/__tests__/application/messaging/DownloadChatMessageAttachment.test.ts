/**
 * messaging-inbox-v2-media (F1.5 fase A, Tanda 1 · B3) — DownloadChatMessageAttachment
 * (spec MEDIA-2, scenarios 6/7/9/10). In-memory ports (ChatMessageAttachmentRepository,
 * ChatMessageRepository, FileStorage) + FakeChatwootGateway — no Prisma mocking.
 */
import { DownloadChatMessageAttachment } from '@application/use-cases/messaging/DownloadChatMessageAttachment';
import { InMemoryChatMessageAttachmentRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageAttachmentRepository';
import { InMemoryChatMessageRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageRepository';
import { InMemoryFileStorage } from '@infrastructure/adapters/in-memory/InMemoryFileStorage';
import { FakeChatwootGateway } from '../../helpers/FakeChatwootGateway';

async function makeHarness() {
  const attachments = new InMemoryChatMessageAttachmentRepository();
  const messages = new InMemoryChatMessageRepository();
  const storage = new InMemoryFileStorage();
  const gateway = new FakeChatwootGateway();
  const uc = new DownloadChatMessageAttachment(attachments, messages, gateway, storage);

  const message = await messages.upsertByChatwootMessageId({
    conversationId: 'conv-1',
    chatwootMessageId: 900,
    direction: 'inbound',
    content: '',
    chatwootCreatedAt: new Date().toISOString(),
  });

  return { attachments, messages, storage, gateway, uc, message };
}

describe('DownloadChatMessageAttachment', () => {
  it('scenario 6 — happy path imagen con thumbnail: baja original+thumb, pasa a downloaded', async () => {
    const { attachments, storage, gateway, uc, message } = await makeHarness();
    const row = await attachments.upsertByChatwootAttachmentId({
      messageId: message.id,
      chatwootAttachmentId: 1,
      fileType: 'image',
      contentType: 'image/jpeg',
      sizeBytes: 1000,
      sourceUrl: 'https://chat.ipnext.com.ar/x/1.jpg',
      thumbSourceUrl: 'https://chat.ipnext.com.ar/x/1-thumb.jpg',
    });
    gateway.downloadsByUrl.set('https://chat.ipnext.com.ar/x/1.jpg', {
      buffer: Buffer.from('ORIGINAL-BYTES'),
      contentType: 'image/jpeg',
    });
    gateway.downloadsByUrl.set('https://chat.ipnext.com.ar/x/1-thumb.jpg', {
      buffer: Buffer.from('THUMB-BYTES'),
      contentType: 'image/jpeg',
    });

    await uc.execute(row.id);

    const updated = await attachments.findById(row.id);
    expect(updated!.status).toBe('downloaded');
    expect(updated!.storageKey).toBe(`messaging/conv-1/${row.id}.jpg`);
    expect(updated!.thumbStorageKey).toBe(`messaging/conv-1/${row.id}-thumb.jpg`);

    const original = await storage.get(updated!.storageKey!);
    expect(original!.buffer.toString()).toBe('ORIGINAL-BYTES');
    const thumb = await storage.get(updated!.thumbStorageKey!);
    expect(thumb!.buffer.toString()).toBe('THUMB-BYTES');
  });

  it('video/audio/file NO bajan thumbnail (thumbStorageKey queda null)', async () => {
    const { attachments, gateway, uc, message } = await makeHarness();
    const row = await attachments.upsertByChatwootAttachmentId({
      messageId: message.id,
      chatwootAttachmentId: 2,
      fileType: 'video',
      contentType: 'video/mp4',
      sourceUrl: 'https://chat.ipnext.com.ar/x/2.mp4',
    });
    gateway.downloadsByUrl.set('https://chat.ipnext.com.ar/x/2.mp4', {
      buffer: Buffer.from('VIDEO-BYTES'),
      contentType: 'video/mp4',
    });

    await uc.execute(row.id);

    const updated = await attachments.findById(row.id);
    expect(updated!.status).toBe('downloaded');
    expect(updated!.thumbStorageKey).toBeNull();
  });

  it('scenario 7 — tamaño reportado excede el límite del fileType → failed sin llamar a FileStorage.save', async () => {
    const { attachments, storage, uc, message } = await makeHarness();
    const saveSpy = jest.spyOn(storage, 'save');
    const row = await attachments.upsertByChatwootAttachmentId({
      messageId: message.id,
      chatwootAttachmentId: 3,
      fileType: 'file',
      contentType: 'application/pdf',
      sizeBytes: 101 * 1024 * 1024, // > 100MB limit for 'file'
      sourceUrl: 'https://chat.ipnext.com.ar/x/3.pdf',
    });

    await uc.execute(row.id);

    const updated = await attachments.findById(row.id);
    expect(updated!.status).toBe('failed');
    expect(updated!.downloadAttempts).toBe(1);
    expect(updated!.lastError).toMatch(/exceed/i);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('tamaño real bajado (sin sizeBytes reportado) excede el límite → failed sin subir nada', async () => {
    const { attachments, storage, gateway, uc, message } = await makeHarness();
    const saveSpy = jest.spyOn(storage, 'save');
    const row = await attachments.upsertByChatwootAttachmentId({
      messageId: message.id,
      chatwootAttachmentId: 4,
      fileType: 'image', // 5MB limit
      contentType: 'image/jpeg',
      sourceUrl: 'https://chat.ipnext.com.ar/x/4.jpg',
    });
    gateway.downloadsByUrl.set('https://chat.ipnext.com.ar/x/4.jpg', {
      buffer: Buffer.alloc(6 * 1024 * 1024, 0x41), // 6MB > 5MB image limit
      contentType: 'image/jpeg',
    });

    await uc.execute(row.id);

    const updated = await attachments.findById(row.id);
    expect(updated!.status).toBe('failed');
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('scenario 9 — Chatwoot inalcanzable/timeout → markFailed incrementa attempts + lastError, no lanza', async () => {
    const { attachments, gateway, uc, message } = await makeHarness();
    gateway.failDownloadAttachment = true;
    const row = await attachments.upsertByChatwootAttachmentId({
      messageId: message.id,
      chatwootAttachmentId: 5,
      fileType: 'audio',
      contentType: 'audio/ogg',
      sourceUrl: 'https://chat.ipnext.com.ar/x/5.ogg',
    });

    await expect(uc.execute(row.id)).resolves.toBeUndefined();

    const updated = await attachments.findById(row.id);
    expect(updated!.status).toBe('failed');
    expect(updated!.downloadAttempts).toBe(1);
    expect(updated!.lastError).toBeTruthy();
  });

  it('scenario 10 — fila YA downloaded es un no-op: no llama al gateway ni a FileStorage', async () => {
    const { attachments, storage, gateway, uc, message } = await makeHarness();
    const gatewaySpy = jest.spyOn(gateway, 'downloadAttachment');
    const saveSpy = jest.spyOn(storage, 'save');
    const row = await attachments.upsertByChatwootAttachmentId({
      messageId: message.id,
      chatwootAttachmentId: 6,
      fileType: 'file',
      contentType: 'application/pdf',
      sourceUrl: 'https://chat.ipnext.com.ar/x/6.pdf',
    });
    await attachments.markDownloaded(row.id, { storageKey: 'messaging/conv-1/already.pdf' });

    await uc.execute(row.id);

    expect(gatewaySpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('attachmentId inexistente → no-op silencioso (no lanza)', async () => {
    const { uc } = await makeHarness();
    await expect(uc.execute('ghost-id')).resolves.toBeUndefined();
  });

  describe('fix-be #1 (HIGH) — memoria/timeout hardening: maxBytes forwarded al gateway', () => {
    it('pasa {maxBytes} (por fileType) al gateway.downloadAttachment del ORIGINAL', async () => {
      const { attachments, gateway, uc, message } = await makeHarness();
      const spy = jest.spyOn(gateway, 'downloadAttachment');
      const row = await attachments.upsertByChatwootAttachmentId({
        messageId: message.id,
        chatwootAttachmentId: 10,
        fileType: 'image', // 5MB ceiling
        contentType: 'image/jpeg',
        sourceUrl: 'https://chat.ipnext.com.ar/x/10.jpg',
      });

      await uc.execute(row.id);

      expect(spy).toHaveBeenCalledWith('https://chat.ipnext.com.ar/x/10.jpg', { maxBytes: 5 * 1024 * 1024 });
    });

    it('pasa el mismo {maxBytes} del row también al gateway.downloadAttachment del THUMBNAIL', async () => {
      const { attachments, gateway, uc, message } = await makeHarness();
      const spy = jest.spyOn(gateway, 'downloadAttachment');
      const row = await attachments.upsertByChatwootAttachmentId({
        messageId: message.id,
        chatwootAttachmentId: 11,
        fileType: 'image',
        contentType: 'image/jpeg',
        sourceUrl: 'https://chat.ipnext.com.ar/x/11.jpg',
        thumbSourceUrl: 'https://chat.ipnext.com.ar/x/11-thumb.jpg',
      });

      await uc.execute(row.id);

      expect(spy).toHaveBeenCalledWith('https://chat.ipnext.com.ar/x/11-thumb.jpg', { maxBytes: 5 * 1024 * 1024 });
    });

    it('video/audio/file usan el ceiling de SU fileType, no el default de imagen', async () => {
      const { attachments, gateway, uc, message } = await makeHarness();
      const spy = jest.spyOn(gateway, 'downloadAttachment');
      const row = await attachments.upsertByChatwootAttachmentId({
        messageId: message.id,
        chatwootAttachmentId: 12,
        fileType: 'video', // 16MB ceiling
        contentType: 'video/mp4',
        sourceUrl: 'https://chat.ipnext.com.ar/x/12.mp4',
      });

      await uc.execute(row.id);

      expect(spy).toHaveBeenCalledWith('https://chat.ipnext.com.ar/x/12.mp4', { maxBytes: 16 * 1024 * 1024 });
    });

    it('el gateway abortando a mitad de stream (maxBytes excedido) o timeout de un data_url colgado → markFailed, NUNCA lanza (sin OOM, sin dejar inFlight/lock colgado)', async () => {
      const { attachments, gateway, uc, message } = await makeHarness();
      const row = await attachments.upsertByChatwootAttachmentId({
        messageId: message.id,
        chatwootAttachmentId: 13,
        fileType: 'file',
        contentType: 'application/pdf',
        sourceUrl: 'https://chat.ipnext.com.ar/x/13.pdf',
      });
      // fix-be #5 — selective-fail-by-URL (no un boolean global): simula el gateway
      // abortando ESTA descarga puntual (axios ERR_FR_MAX_CONTENT_LENGTH_EXCEEDED /
      // ETIMEDOUT), sin afectar otras descargas del mismo test run.
      gateway.failUrls.add('https://chat.ipnext.com.ar/x/13.pdf');

      await expect(uc.execute(row.id)).resolves.toBeUndefined();

      const updated = await attachments.findById(row.id);
      expect(updated!.status).toBe('failed');
      expect(updated!.downloadAttempts).toBe(1);
    });
  });

  describe('fix-be #5 (BAJO) — degrade selectivo del thumbnail vía FakeChatwootGateway.failUrls', () => {
    it('original OK + thumb falla (failUrls solo con la url del thumb) → downloaded con thumbStorageKey null, NO falla todo el attachment', async () => {
      const { attachments, gateway, uc, message } = await makeHarness();
      const row = await attachments.upsertByChatwootAttachmentId({
        messageId: message.id,
        chatwootAttachmentId: 14,
        fileType: 'image',
        contentType: 'image/jpeg',
        sourceUrl: 'https://chat.ipnext.com.ar/x/14.jpg',
        thumbSourceUrl: 'https://chat.ipnext.com.ar/x/14-thumb.jpg',
      });
      gateway.downloadsByUrl.set('https://chat.ipnext.com.ar/x/14.jpg', {
        buffer: Buffer.from('ORIGINAL-BYTES'),
        contentType: 'image/jpeg',
      });
      gateway.failUrls.add('https://chat.ipnext.com.ar/x/14-thumb.jpg'); // SOLO el thumb falla

      await uc.execute(row.id);

      const updated = await attachments.findById(row.id);
      expect(updated!.status).toBe('downloaded');
      expect(updated!.storageKey).toBe(`messaging/conv-1/${row.id}.jpg`);
      expect(updated!.thumbStorageKey).toBeNull();
    });
  });
});
