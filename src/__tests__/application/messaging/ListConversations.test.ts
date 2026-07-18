/**
 * messaging-inbox (F1, batch B4) — ListConversations (INBOX-1). Paginated listing
 * mapped to `ConversationListItemDto` (never the raw mirror record), ordered by
 * `lastMessageAt` DESC. Sort order itself is InMemoryConversationRepository's job
 * (already TDD'd in B2) — this suite asserts the use case wires pagination through
 * and maps to the DTO shape (including the `lastMessagePreview` → `preview` rename).
 */
import { ListConversations } from '@application/use-cases/messaging/ListConversations';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';

describe('ListConversations', () => {
  it('INBOX-1: returns conversations ordered by lastMessageAt DESC, mapped to DTO', async () => {
    const repo = new InMemoryConversationRepository();
    await repo.upsertByChatwootId({
      chatwootConversationId: 1,
      contactName: 'Cliente A',
      contactPhone: '+5492324000001',
      lastMessageAt: '2026-07-01T10:00:00.000Z',
      lastMessagePreview: 'Mensaje viejo',
      status: 'open',
    });
    await repo.upsertByChatwootId({
      chatwootConversationId: 2,
      contactName: 'Cliente B',
      contactPhone: '+5492324000002',
      lastMessageAt: '2026-07-10T10:00:00.000Z',
      lastMessagePreview: 'Mensaje reciente',
      status: 'open',
    });
    await repo.upsertByChatwootId({
      chatwootConversationId: 3,
      contactName: 'Cliente C',
      contactPhone: '+5492324000003',
      lastMessageAt: '2026-07-05T10:00:00.000Z',
      lastMessagePreview: 'Mensaje medio',
      status: 'resolved',
    });

    const uc = new ListConversations(repo);
    const result = await uc.execute({});

    expect(result.data.map((d) => d.contactName)).toEqual(['Cliente B', 'Cliente C', 'Cliente A']);
    expect(result.data[0]).toEqual({
      id: expect.any(String),
      contactName: 'Cliente B',
      contactPhone: '+5492324000002',
      lastMessageAt: '2026-07-10T10:00:00.000Z',
      preview: 'Mensaje reciente', // renamed from lastMessagePreview (design §5)
      status: 'open',
      snoozedUntil: null, // conversation-snooze (Ola 6c) — sin snooze por defecto
      assignee: null, // F1.5-C2 — unassigned by default
      area: null, // F1.5-C2 — no area by default
      campaigns: [], // messaging-bulk-inbox (F1) — sin campañas por defecto
      labels: [], // conversation-labels (Ola 5) — sin etiquetas por defecto
      internalNoteCount: 0, // messaging-inbox-notes (edit/delete) — sin notas por defecto
    });
    expect(result.total).toBe(3);
  });

  it('INBOX-1: an empty mirror returns an empty page, not an error', async () => {
    const repo = new InMemoryConversationRepository();
    const uc = new ListConversations(repo);

    const result = await uc.execute({});

    expect(result.data).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('forwards page/limit to the repository (dto/pagination.ts contract)', async () => {
    const repo = new InMemoryConversationRepository();
    for (let i = 1; i <= 5; i++) {
      await repo.upsertByChatwootId({
        chatwootConversationId: i,
        lastMessageAt: `2026-07-0${i}T10:00:00.000Z`,
      });
    }
    const uc = new ListConversations(repo);

    const result = await uc.execute({ page: 2, limit: 2 });

    expect(result.page).toBe(2);
    expect(result.limit).toBe(2);
    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(5);
  });

  // ─── F1.5-C2 (asignación) — filtro server-side Mine/Unassigned/All ──────────

  describe('filtro de asignación', () => {
    async function seedThree(repo: InMemoryConversationRepository) {
      const a = await repo.upsertByChatwootId({ chatwootConversationId: 10, contactName: 'A', lastMessageAt: '2026-07-01T00:00:00.000Z' });
      const b = await repo.upsertByChatwootId({ chatwootConversationId: 11, contactName: 'B', lastMessageAt: '2026-07-02T00:00:00.000Z' });
      const c = await repo.upsertByChatwootId({ chatwootConversationId: 12, contactName: 'C', lastMessageAt: '2026-07-03T00:00:00.000Z' });
      repo.seedUsers([{ id: 'user-1', name: 'Agente Uno' }, { id: 'user-2', name: 'Agente Dos' }]);
      await repo.updateLocalFields(a.id, { assigneeId: 'user-1' });
      await repo.updateLocalFields(b.id, { assigneeId: 'user-2' });
      // c queda sin asignar
      return { a, b, c };
    }

    it("assigneeId → 'mine': devuelve SOLO las conversaciones asignadas a ese userId", async () => {
      const repo = new InMemoryConversationRepository();
      const { a } = await seedThree(repo);
      const uc = new ListConversations(repo);

      const result = await uc.execute({ assigneeId: 'user-1' });

      expect(result.data.map((d) => d.id)).toEqual([a.id]);
      expect(result.data[0]!.assignee).toEqual({ id: 'user-1', name: 'Agente Uno' });
    });

    it("unassigned:true → devuelve SOLO las conversaciones sin assigneeId", async () => {
      const repo = new InMemoryConversationRepository();
      const { c } = await seedThree(repo);
      const uc = new ListConversations(repo);

      const result = await uc.execute({ unassigned: true });

      expect(result.data.map((d) => d.id)).toEqual([c.id]);
      expect(result.data[0]!.assignee).toBeNull();
    });

    it('sin filtro (all) → devuelve las 3, con su assignee resuelto por fila', async () => {
      const repo = new InMemoryConversationRepository();
      await seedThree(repo);
      const uc = new ListConversations(repo);

      const result = await uc.execute({});

      expect(result.data).toHaveLength(3);
      expect(result.total).toBe(3);
    });
  });
});
