// randomUUID is non-configurable on the real `crypto` module (jest.spyOn can't
// redefine it) — mock the whole module, keeping every other export real, so the
// §8 tiebreaker test below can force a deterministic (and insertion-REVERSED) id
// sequence.
jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  randomUUID: jest.fn(jest.requireActual('crypto').randomUUID),
}));

import * as crypto from 'crypto';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { UpsertConversationInput } from '@domain/ports/ConversationRepository';

const mockRandomUUID = crypto.randomUUID as unknown as jest.Mock;

function input(overrides: Partial<UpsertConversationInput> = {}): UpsertConversationInput {
  return {
    chatwootConversationId: 500,
    ...overrides,
  };
}

describe('InMemoryConversationRepository', () => {
  let repo: InMemoryConversationRepository;

  beforeEach(() => {
    repo = new InMemoryConversationRepository();
  });

  it('upsertByChatwootId creates a new conversation with schema defaults when unset', async () => {
    const created = await repo.upsertByChatwootId(input({ contactName: 'Juan', contactPhone: '+5491111' }));

    expect(created.chatwootConversationId).toBe(500);
    expect(created.contactName).toBe('Juan');
    expect(created.contactPhone).toBe('+5491111');
    expect(created.status).toBe('open');
    expect(created.canReply).toBe(false);
    expect(created.lastMessageAt).toBeNull();
    expect(created.id).toBeTruthy();
  });

  it('upsertByChatwootId is idempotent by chatwootConversationId — same id does NOT duplicate', async () => {
    const first = await repo.upsertByChatwootId(input());
    const second = await repo.upsertByChatwootId(input({ status: 'resolved' }));

    expect(second.id).toBe(first.id);
    expect(second.status).toBe('resolved');

    const page = await repo.list({ page: 1, limit: 10 });
    expect(page.data).toHaveLength(1);
  });

  it('upsertByChatwootId leaves UNSET fields untouched on update (conversation_status_changed — updates only status)', async () => {
    await repo.upsertByChatwootId(input({ contactName: 'Juan', contactPhone: '+5491111', canReply: true }));

    const updated = await repo.upsertByChatwootId(input({ status: 'resolved' }));

    expect(updated.status).toBe('resolved');
    expect(updated.contactName).toBe('Juan');
    expect(updated.contactPhone).toBe('+5491111');
    expect(updated.canReply).toBe(true);
  });

  it('findById returns null for an unknown id', async () => {
    expect(await repo.findById('nope')).toBeNull();
  });

  it('findByChatwootId returns null when not seen yet', async () => {
    expect(await repo.findByChatwootId(999)).toBeNull();
  });

  it('list orders conversations by lastMessageAt DESC (INBOX-1)', async () => {
    await repo.upsertByChatwootId(
      input({ chatwootConversationId: 1, lastMessageAt: '2026-07-10T10:00:00.000Z', contactName: 'viejo' }),
    );
    await repo.upsertByChatwootId(
      input({ chatwootConversationId: 2, lastMessageAt: '2026-07-11T10:00:00.000Z', contactName: 'nuevo' }),
    );
    await repo.upsertByChatwootId(
      input({ chatwootConversationId: 3, lastMessageAt: '2026-07-09T10:00:00.000Z', contactName: 'antiguo' }),
    );

    const page = await repo.list({ page: 1, limit: 10 });

    expect(page.data.map((c) => c.contactName)).toEqual(['nuevo', 'viejo', 'antiguo']);
    expect(page.total).toBe(3);
  });

  it('list returns an empty page when there are no conversations (INBOX-1)', async () => {
    const page = await repo.list({ page: 1, limit: 10 });

    expect(page.data).toEqual([]);
    expect(page.total).toBe(0);
  });

  describe('inbox-template-send (PORT-2) — bumpLastMessage', () => {
    it('escribe SOLO lastMessageAt/lastMessagePreview — canReply/status/assigneeId quedan intactos (design D2)', async () => {
      const conv = await repo.upsertByChatwootId(
        input({ chatwootConversationId: 200, canReply: false, status: 'open' }),
      );
      await repo.updateLocalFields(conv.id, { assigneeId: 'u1' });

      const updated = await repo.bumpLastMessage(conv.id, {
        lastMessageAt: '2026-07-16T10:00:00.000Z',
        lastMessagePreview: 'Hola Juan, debés $5.000',
      });

      expect(updated!.lastMessageAt).toBe('2026-07-16T10:00:00.000Z');
      expect(updated!.lastMessagePreview).toBe('Hola Juan, debés $5.000');
      expect(updated!.canReply).toBe(false);
      expect(updated!.status).toBe('open');
      expect(updated!.assigneeId).toBe('u1');
    });

    it('conversación inexistente → null', async () => {
      const result = await repo.bumpLastMessage('ghost', {
        lastMessageAt: '2026-07-16T10:00:00.000Z',
        lastMessagePreview: 'x',
      });

      expect(result).toBeNull();
    });
  });

  describe('§8 — tiebreaker determinístico en empates de lastMessageAt (in-memory DEBE ordenar igual que Prisma)', () => {
    it('dos conversaciones con el MISMO lastMessageAt se ordenan por id ASC, no por orden de insercion', async () => {
      // Postgres sin una clave secundaria en ORDER BY no garantiza NADA sobre el
      // orden de filas empatadas — a diferencia del Array.prototype.sort de JS
      // (estable desde ES2019), que preservaria el orden de insercion y
      // enmascararia el bug acá. Mockeamos randomUUID para forzar que el id
      // generado quede en el orden CONTRARIO al de insercion: solo un tiebreaker
      // explícito por id puede hacer pasar la aserción de abajo.
      mockRandomUUID.mockReturnValueOnce('bbbbbbbb-0000-0000-0000-000000000000');
      mockRandomUUID.mockReturnValueOnce('aaaaaaaa-0000-0000-0000-000000000000');

      const same = '2026-07-11T10:00:00.000Z';
      await repo.upsertByChatwootId(input({ chatwootConversationId: 1, lastMessageAt: same, contactName: 'primero-insertado' }));
      await repo.upsertByChatwootId(input({ chatwootConversationId: 2, lastMessageAt: same, contactName: 'segundo-insertado' }));

      const page = await repo.list({ page: 1, limit: 10 });

      // Insertion order was [id=bbb.., id=aaa..] — a bare stable sort would keep
      // that order. An id ASC tiebreaker must reverse it to [aaa.., bbb..].
      expect(page.data.map((c) => c.contactName)).toEqual(['segundo-insertado', 'primero-insertado']);
    });
  });
});
