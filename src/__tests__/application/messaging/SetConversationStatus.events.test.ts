/**
 * conversation-events (Ola 2) — SetConversationStatus ahora registra el evento resolved/
 * reopened (best-effort) y mantiene resolvedAt/firstResolvedAt atómicos con el status.
 */
import { SetConversationStatus } from '@application/use-cases/messaging/SetConversationStatus';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryConversationEventRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationEventRepository';
import { FakeChatwootGateway } from '../../helpers/FakeChatwootGateway';

function makeHarness() {
  const conversationRepo = new InMemoryConversationRepository();
  const gateway = new FakeChatwootGateway();
  const eventRepo = new InMemoryConversationEventRepository();
  const uc = new SetConversationStatus(conversationRepo, gateway, eventRepo);
  return { conversationRepo, gateway, eventRepo, uc };
}

describe('SetConversationStatus — conversation-events (Ola 2)', () => {
  it('resolver (open→resolved): evento "resolved" con actor + from/to, setea resolvedAt y firstResolvedAt', async () => {
    const { conversationRepo, eventRepo, uc } = makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 200, status: 'open' });

    await uc.execute(conv.id, 'resolved', 'user-9');

    const events = await eventRepo.listByConversation(conv.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'resolved', actorId: 'user-9', fromValue: 'open', toValue: 'resolved' });

    const updated = await conversationRepo.findById(conv.id);
    expect(updated!.resolvedAt).not.toBeNull();
    expect(updated!.firstResolvedAt).toBe(updated!.resolvedAt); // primera resolución: ambos iguales
  });

  it('reabrir (resolved→open): evento "reopened", limpia resolvedAt a null pero PRESERVA firstResolvedAt', async () => {
    const { conversationRepo, eventRepo, uc } = makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 201, status: 'open' });
    await uc.execute(conv.id, 'resolved', 'user-1');
    const afterResolve = await conversationRepo.findById(conv.id);
    const firstResolved = afterResolve!.firstResolvedAt;

    await uc.execute(conv.id, 'open', 'user-2');

    const events = await eventRepo.listByConversation(conv.id);
    expect(events.map((e) => e.type)).toEqual(['resolved', 'reopened']);
    expect(events[1]).toMatchObject({ type: 'reopened', actorId: 'user-2', fromValue: 'resolved', toValue: 'open' });

    const reopened = await conversationRepo.findById(conv.id);
    expect(reopened!.resolvedAt).toBeNull(); // se limpia
    expect(reopened!.firstResolvedAt).toBe(firstResolved); // NUNCA se limpia
  });

  it('resolve→reopen→resolve: firstResolvedAt queda con la PRIMERA resolución', async () => {
    const { conversationRepo, uc } = makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 202, status: 'open' });
    await uc.execute(conv.id, 'resolved', 'u');
    const first = (await conversationRepo.findById(conv.id))!.firstResolvedAt;
    await uc.execute(conv.id, 'open', 'u');
    await uc.execute(conv.id, 'resolved', 'u');

    const final = await conversationRepo.findById(conv.id);
    expect(final!.firstResolvedAt).toBe(first); // la PRIMERA, no la segunda
    expect(final!.resolvedAt).not.toBeNull();
  });

  it('best-effort: un fallo al registrar el evento NO tumba el cambio de estado', async () => {
    const { conversationRepo, eventRepo, uc } = makeHarness();
    eventRepo.failRecord = true;
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 203, status: 'open' });

    await expect(uc.execute(conv.id, 'resolved', 'user-1')).resolves.toMatchObject({ status: 'resolved' });

    const updated = await conversationRepo.findById(conv.id);
    expect(updated!.status).toBe('resolved');
    expect(updated!.resolvedAt).not.toBeNull(); // resolvedAt SÍ se persiste (va en el upsert, no es best-effort)
    expect(await eventRepo.listByConversation(conv.id)).toHaveLength(0); // el evento se perdió (best-effort)
  });

  it('transición NO resolve/reopen (open→pending): sin evento, sin tocar resolvedAt', async () => {
    const { conversationRepo, eventRepo, uc } = makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 204, status: 'open' });

    await uc.execute(conv.id, 'pending', 'user-1');

    expect(await eventRepo.listByConversation(conv.id)).toHaveLength(0);
    const updated = await conversationRepo.findById(conv.id);
    expect(updated!.resolvedAt).toBeNull();
    expect(updated!.firstResolvedAt).toBeNull();
  });

  it('resolve idempotente (resolved→resolved): sin nuevo evento, firstResolvedAt intacto', async () => {
    const { conversationRepo, eventRepo, uc } = makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 205, status: 'open' });
    await uc.execute(conv.id, 'resolved', 'u');
    const first = (await conversationRepo.findById(conv.id))!.firstResolvedAt;

    await uc.execute(conv.id, 'resolved', 'u');

    expect(await eventRepo.listByConversation(conv.id)).toHaveLength(1); // sólo el primero
    expect((await conversationRepo.findById(conv.id))!.firstResolvedAt).toBe(first);
  });

  it('actorId ausente → evento con actorId null (degrada seguro)', async () => {
    const { conversationRepo, eventRepo, uc } = makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 206, status: 'open' });

    await uc.execute(conv.id, 'resolved');

    expect((await eventRepo.listByConversation(conv.id))[0]!.actorId).toBeNull();
  });
});
