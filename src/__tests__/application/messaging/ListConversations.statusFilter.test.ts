/**
 * inbox-resolve (T3, LS-1) — `ListConversations` es passthrough puro del filtro
 * `status`: el query llega al repo TAL CUAL (la semántica de bucket vive en el
 * adapter, ya cubierta por InMemoryConversationRepository.test.ts /
 * PrismaConversationRepository.orderBy.test.ts). Naming espejo de
 * `ListConversations.campaignFilter.test.ts`. También pinea que el DTO expone
 * `status` (ya existente — no-regresión).
 */
import { ListConversations } from '@application/use-cases/messaging/ListConversations';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';

describe('ListConversations — filtro por status (T3, inbox-resolve LS-1)', () => {
  it('?status=open llega al repo tal cual y devuelve solo el bucket ACTIVAS', async () => {
    const repo = new InMemoryConversationRepository();
    const uc = new ListConversations(repo);

    const open = await repo.upsertByChatwootId({
      chatwootConversationId: 1,
      contactName: 'Abierta',
      status: 'open',
      lastMessageAt: '2026-07-15T10:00:00.000Z',
    });
    await repo.upsertByChatwootId({
      chatwootConversationId: 2,
      contactName: 'Resuelta',
      status: 'resolved',
      lastMessageAt: '2026-07-16T10:00:00.000Z',
    });

    const result = await uc.execute({ status: 'open' });

    expect(result.data.map((d) => d.id)).toEqual([open.id]);
    expect(result.total).toBe(1);
  });

  it('?status=resolved llega al repo tal cual y devuelve solo el bucket RESUELTAS', async () => {
    const repo = new InMemoryConversationRepository();
    const uc = new ListConversations(repo);

    await repo.upsertByChatwootId({
      chatwootConversationId: 1,
      contactName: 'Abierta',
      status: 'open',
      lastMessageAt: '2026-07-15T10:00:00.000Z',
    });
    const resolved = await repo.upsertByChatwootId({
      chatwootConversationId: 2,
      contactName: 'Resuelta',
      status: 'resolved',
      lastMessageAt: '2026-07-16T10:00:00.000Z',
    });

    const result = await uc.execute({ status: 'resolved' });

    expect(result.data.map((d) => d.id)).toEqual([resolved.id]);
    expect(result.total).toBe(1);
  });

  it('sin status → sin filtro (no-regresión) y el DTO expone `status` por fila', async () => {
    const repo = new InMemoryConversationRepository();
    const uc = new ListConversations(repo);

    await repo.upsertByChatwootId({
      chatwootConversationId: 1,
      contactName: 'Abierta',
      status: 'open',
      lastMessageAt: '2026-07-15T10:00:00.000Z',
    });
    await repo.upsertByChatwootId({
      chatwootConversationId: 2,
      contactName: 'Resuelta',
      status: 'resolved',
      lastMessageAt: '2026-07-16T10:00:00.000Z',
    });

    const result = await uc.execute({});

    expect(result.total).toBe(2);
    // Pin del DTO — status YA se exponía (`dto/messaging.ts` toConversationListItemDto);
    // este assert deja escrito el contrato para que una regresión futura lo rompa acá.
    expect(result.data.map((d) => d.status).sort()).toEqual(['open', 'resolved']);
  });
});
