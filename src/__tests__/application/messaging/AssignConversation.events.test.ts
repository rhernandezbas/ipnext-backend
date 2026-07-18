/**
 * conversation-events (Ola 2) — AssignConversation registra assigned/unassigned (best-effort)
 * con actor y from/to (assignee viejo→nuevo).
 */
import { AssignConversation } from '@application/use-cases/messaging/AssignConversation';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryConversationEventRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationEventRepository';
import type { EntityLookup } from '@domain/ports/EntityLookup';

const anyUserLookup: EntityLookup = { findById: async (id: string) => ({ id, name: `User ${id}` }) };

function makeHarness() {
  const conversationRepo = new InMemoryConversationRepository();
  const eventRepo = new InMemoryConversationEventRepository();
  const uc = new AssignConversation(conversationRepo, anyUserLookup, eventRepo);
  return { conversationRepo, eventRepo, uc };
}

describe('AssignConversation — conversation-events (Ola 2)', () => {
  it('asignar (null→user): evento "assigned" con actor, from=null to=userId', async () => {
    const { conversationRepo, eventRepo, uc } = makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 300, status: 'open' });

    await uc.execute(conv.id, 'user-1', 'actor-1');

    const events = await eventRepo.listByConversation(conv.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'assigned', actorId: 'actor-1', fromValue: null, toValue: 'user-1' });
  });

  it('reasignar (user1→user2): evento "assigned" from=user1 to=user2', async () => {
    const { conversationRepo, eventRepo, uc } = makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 301, status: 'open' });
    await uc.execute(conv.id, 'user-1', 'actor-1');

    await uc.execute(conv.id, 'user-2', 'actor-2');

    const events = await eventRepo.listByConversation(conv.id);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: 'assigned', fromValue: 'user-1', toValue: 'user-2' });
  });

  it('desasignar (user→null): evento "unassigned" from=user to=null', async () => {
    const { conversationRepo, eventRepo, uc } = makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 302, status: 'open' });
    await uc.execute(conv.id, 'user-1', 'actor-1');

    await uc.execute(conv.id, null, 'actor-3');

    const events = await eventRepo.listByConversation(conv.id);
    expect(events[1]).toMatchObject({ type: 'unassigned', actorId: 'actor-3', fromValue: 'user-1', toValue: null });
  });

  it('sin cambio (mismo assignee): NO registra evento', async () => {
    const { conversationRepo, eventRepo, uc } = makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 303, status: 'open' });
    await uc.execute(conv.id, 'user-1', 'actor-1');

    await uc.execute(conv.id, 'user-1', 'actor-1');

    expect(await eventRepo.listByConversation(conv.id)).toHaveLength(1);
  });

  it('best-effort: un fallo al registrar el evento NO tumba la asignación', async () => {
    const { conversationRepo, eventRepo, uc } = makeHarness();
    eventRepo.failRecord = true;
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 304, status: 'open' });

    await expect(uc.execute(conv.id, 'user-1', 'actor-1')).resolves.toMatchObject({ assignee: { id: 'user-1' } });

    expect((await conversationRepo.findById(conv.id))!.assigneeId).toBe('user-1'); // se persistió
    expect(await eventRepo.listByConversation(conv.id)).toHaveLength(0); // evento perdido
  });
});
