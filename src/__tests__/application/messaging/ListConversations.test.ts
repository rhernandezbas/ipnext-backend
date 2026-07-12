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
});
