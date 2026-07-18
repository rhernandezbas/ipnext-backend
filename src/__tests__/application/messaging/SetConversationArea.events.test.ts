/**
 * conversation-events (Ola 2) — SetConversationArea registra 'area_changed' (best-effort) con
 * actor y from/to (área vieja→nueva), incluso al limpiar el área (to=null).
 */
import { SetConversationArea } from '@application/use-cases/messaging/SetConversationArea';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryConversationEventRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationEventRepository';
import { InMemoryTicketAreaCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketAreaCatalogRepository';

async function makeHarness() {
  const conversationRepo = new InMemoryConversationRepository();
  const areaRepo = new InMemoryTicketAreaCatalogRepository();
  conversationRepo.seedAreas(areaRepo);
  const eventRepo = new InMemoryConversationEventRepository();
  const uc = new SetConversationArea(conversationRepo, areaRepo, eventRepo);
  const areaA = await areaRepo.create({ name: 'Soporte', color: '#111111' });
  const areaB = await areaRepo.create({ name: 'Ventas', color: '#222222' });
  return { conversationRepo, areaRepo, eventRepo, uc, areaA, areaB };
}

describe('SetConversationArea — conversation-events (Ola 2)', () => {
  it('setear área (null→A): evento "area_changed" con actor, from=null to=A', async () => {
    const { conversationRepo, eventRepo, uc, areaA } = await makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 400, status: 'open' });

    await uc.execute(conv.id, areaA.id, 'actor-1');

    const events = await eventRepo.listByConversation(conv.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'area_changed', actorId: 'actor-1', fromValue: null, toValue: areaA.id });
  });

  it('cambiar área (A→B): "area_changed" from=A to=B', async () => {
    const { conversationRepo, eventRepo, uc, areaA, areaB } = await makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 401, status: 'open' });
    await uc.execute(conv.id, areaA.id, 'actor-1');

    await uc.execute(conv.id, areaB.id, 'actor-2');

    const events = await eventRepo.listByConversation(conv.id);
    expect(events[1]).toMatchObject({ type: 'area_changed', fromValue: areaA.id, toValue: areaB.id });
  });

  it('limpiar área (A→null): "area_changed" from=A to=null', async () => {
    const { conversationRepo, eventRepo, uc, areaA } = await makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 402, status: 'open' });
    await uc.execute(conv.id, areaA.id, 'actor-1');

    await uc.execute(conv.id, null, 'actor-1');

    const events = await eventRepo.listByConversation(conv.id);
    expect(events[1]).toMatchObject({ type: 'area_changed', fromValue: areaA.id, toValue: null });
  });

  it('sin cambio (misma área): NO registra evento', async () => {
    const { conversationRepo, eventRepo, uc, areaA } = await makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 403, status: 'open' });
    await uc.execute(conv.id, areaA.id, 'actor-1');

    await uc.execute(conv.id, areaA.id, 'actor-1');

    expect(await eventRepo.listByConversation(conv.id)).toHaveLength(1);
  });

  it('best-effort: un fallo al registrar el evento NO tumba el cambio de área', async () => {
    const { conversationRepo, eventRepo, uc, areaA } = await makeHarness();
    eventRepo.failRecord = true;
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 404, status: 'open' });

    await expect(uc.execute(conv.id, areaA.id, 'actor-1')).resolves.toMatchObject({ area: { id: areaA.id } });

    expect((await conversationRepo.findById(conv.id))!.areaId).toBe(areaA.id); // se persistió
    expect(await eventRepo.listByConversation(conv.id)).toHaveLength(0);
  });
});
