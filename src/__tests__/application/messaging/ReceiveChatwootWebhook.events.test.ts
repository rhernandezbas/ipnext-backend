/**
 * conversation-events (Ola 2) — el webhook registra 'created' (actor null) al NACER la
 * conversación, y resolved/reopened Chatwoot-driven (echo-safe vía prev!=next), best-effort.
 */
import { ReceiveChatwootWebhook } from '@application/use-cases/messaging/ReceiveChatwootWebhook';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryChatMessageRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageRepository';
import { InMemoryWebhookDeliveryRepository } from '@infrastructure/adapters/in-memory/InMemoryWebhookDeliveryRepository';
import { InMemoryConversationEventRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationEventRepository';

function makeUseCase() {
  const conversationRepo = new InMemoryConversationRepository();
  const messageRepo = new InMemoryChatMessageRepository();
  const deliveryRepo = new InMemoryWebhookDeliveryRepository();
  const eventRepo = new InMemoryConversationEventRepository();
  const uc = new ReceiveChatwootWebhook(conversationRepo, messageRepo, deliveryRepo, undefined, undefined, undefined, eventRepo);
  return { uc, conversationRepo, messageRepo, eventRepo };
}

const inboundMsg = (cwConvId: number, msgId: number) => ({
  event: 'message_created',
  id: msgId,
  content: 'Hola',
  message_type: 'incoming',
  created_at: 1735689600,
  conversation: { id: cwConvId, meta: { sender: { name: 'Juan', phone_number: '+5492324421234' } } },
  sender: { name: 'Juan' },
});

describe('ReceiveChatwootWebhook — conversation-events (Ola 2)', () => {
  it('primer message_created de una conversación nueva → evento "created" con actor null', async () => {
    const { uc, conversationRepo, eventRepo } = makeUseCase();

    await uc.execute('d1', inboundMsg(42, 501));

    const conv = await conversationRepo.findByChatwootId(42);
    const events = await eventRepo.listByConversation(conv!.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'created', actorId: null });
  });

  it('mensajes posteriores en la MISMA conversación → NO otro "created"', async () => {
    const { uc, conversationRepo, eventRepo } = makeUseCase();
    await uc.execute('d1', inboundMsg(42, 501));
    await uc.execute('d2', inboundMsg(42, 502));

    const conv = await conversationRepo.findByChatwootId(42);
    const created = (await eventRepo.listByConversation(conv!.id)).filter((e) => e.type === 'created');
    expect(created).toHaveLength(1);
  });

  it('conversation_created → evento "created" con actor null', async () => {
    const { uc, conversationRepo, eventRepo } = makeUseCase();

    await uc.execute('d1', {
      event: 'conversation_created',
      id: 77,
      status: 'open',
      meta: { sender: { name: 'Ana', phone_number: '+5492324420000' } },
    });

    const conv = await conversationRepo.findByChatwootId(77);
    expect((await eventRepo.listByConversation(conv!.id)).map((e) => e.type)).toEqual(['created']);
  });

  it('conversation_status_changed → "resolved" (actor null) + setea resolvedAt/firstResolvedAt', async () => {
    const { uc, conversationRepo, eventRepo } = makeUseCase();
    await uc.execute('d1', { event: 'conversation_created', id: 88, status: 'open', meta: { sender: { phone_number: '+5492324420001' } } });

    await uc.execute('d2', { event: 'conversation_status_changed', id: 88, status: 'resolved' });

    const conv = await conversationRepo.findByChatwootId(88);
    const events = await eventRepo.listByConversation(conv!.id);
    expect(events.map((e) => e.type)).toEqual(['created', 'resolved']);
    expect(events[1]).toMatchObject({ type: 'resolved', actorId: null, fromValue: 'open', toValue: 'resolved' });
    expect(conv!.resolvedAt).not.toBeNull();
    expect(conv!.firstResolvedAt).toBe(conv!.resolvedAt);
  });

  it('echo-safe: dos status_changed a "resolved" seguidos → un SOLO evento "resolved"', async () => {
    const { uc, conversationRepo, eventRepo } = makeUseCase();
    await uc.execute('d1', { event: 'conversation_created', id: 99, status: 'open', meta: { sender: { phone_number: '+5492324420002' } } });
    await uc.execute('d2', { event: 'conversation_status_changed', id: 99, status: 'resolved' });

    await uc.execute('d3', { event: 'conversation_status_changed', id: 99, status: 'resolved' });

    const conv = await conversationRepo.findByChatwootId(99);
    const resolved = (await eventRepo.listByConversation(conv!.id)).filter((e) => e.type === 'resolved');
    expect(resolved).toHaveLength(1);
  });

  it('LOW-1: status_changed="resolved" de una conversación INEXISTENTE (webhook desordenado) → se crea con resolvedAt/firstResolvedAt + evento "resolved"', async () => {
    const { uc, conversationRepo, eventRepo } = makeUseCase();

    // El conversation_created se perdió/llegó desordenado: el status_changed es el PRIMER
    // webhook que ve el mirror. La conversación nace 'resolved'.
    await uc.execute('d1', { event: 'conversation_status_changed', id: 555, status: 'resolved' });

    const conv = await conversationRepo.findByChatwootId(555);
    expect(conv).not.toBeNull();
    expect(conv!.status).toBe('resolved');
    expect(conv!.resolvedAt).not.toBeNull(); // invariante: resolved ⟹ resolvedAt
    expect(conv!.firstResolvedAt).toBe(conv!.resolvedAt);

    const events = await eventRepo.listByConversation(conv!.id);
    expect(events.map((e) => e.type)).toEqual(['resolved']);
    expect(events[0]).toMatchObject({ type: 'resolved', actorId: null, fromValue: 'open', toValue: 'resolved' });
  });

  it('LOW-1 contraparte: status_changed="open" de una conversación INEXISTENTE → se crea sin resolvedAt ni evento (no sobre-dispara)', async () => {
    const { uc, conversationRepo, eventRepo } = makeUseCase();

    await uc.execute('d1', { event: 'conversation_status_changed', id: 556, status: 'open' });

    const conv = await conversationRepo.findByChatwootId(556);
    expect(conv!.resolvedAt).toBeNull();
    expect(conv!.firstResolvedAt).toBeNull();
    expect(await eventRepo.listByConversation(conv!.id)).toHaveLength(0);
  });

  it('best-effort: fallo al registrar el evento NO tumba el webhook (el mensaje se espeja igual)', async () => {
    const { uc, conversationRepo, messageRepo, eventRepo } = makeUseCase();
    eventRepo.failRecord = true;

    await expect(uc.execute('d1', inboundMsg(42, 501))).resolves.toBeUndefined();

    const conv = await conversationRepo.findByChatwootId(42);
    expect(conv).not.toBeNull();
    expect(await messageRepo.listByConversation(conv!.id)).toHaveLength(1); // el mensaje SÍ se espejó
    expect(await eventRepo.listByConversation(conv!.id)).toHaveLength(0); // evento perdido (best-effort)
  });
});
