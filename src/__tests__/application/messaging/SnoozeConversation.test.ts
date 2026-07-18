/**
 * conversation-snooze (Ola 6c) — SnoozeConversation: posponer una conversación hasta un
 * timestamp FUTURO (status='snoozed' + snoozedUntil). Desaparece de Abiertas/Sin atender y
 * reaparece sola cuando el timestamp vence (derivación lazy en los buckets + watcher opcional).
 *
 * Gateado por el MISMO permiso que SendMessage (`messaging:send`, ver messaging.routes.ts).
 * `snoozedUntil` es INDEPENDIENTE de `canReply` (la ventana de 24h) — esta use case JAMÁS
 * toca `canReply`. Molde de guards de `SetConversationStatus` (validar → findById → Chatwoot →
 * upsert POST-OK → evento best-effort).
 */
import { SnoozeConversation } from '@application/use-cases/messaging/SnoozeConversation';
import {
  ConversationNotFoundError,
  ChatwootUnavailableError,
  InvalidSnoozeUntilError,
} from '@domain/errors/messaging';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryConversationEventRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationEventRepository';
import { FakeChatwootGateway } from '../../helpers/FakeChatwootGateway';

function futureIso(msFromNow = 60 * 60 * 1000): string {
  return new Date(Date.now() + msFromNow).toISOString();
}
function pastIso(msAgo = 60 * 60 * 1000): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function makeHarness() {
  const conversationRepo = new InMemoryConversationRepository();
  const gateway = new FakeChatwootGateway();
  const eventRepo = new InMemoryConversationEventRepository();
  const uc = new SnoozeConversation(conversationRepo, gateway, eventRepo);
  return { conversationRepo, gateway, eventRepo, uc };
}

describe('SnoozeConversation', () => {
  it('snooze válido → status="snoozed" + snoozedUntil, llama gateway.setStatus con snoozed + snoozedUntil, devuelve el DTO', async () => {
    const { conversationRepo, gateway, uc } = makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 300, status: 'open' });
    const until = futureIso();

    const result = await uc.execute(conv.id, until);

    expect(gateway.setStatusCalls).toEqual([{ chatwootConversationId: 300, status: 'snoozed', snoozedUntil: until }]);
    expect(result).toMatchObject({ id: conv.id, status: 'snoozed', snoozedUntil: until });

    const updated = await conversationRepo.findById(conv.id);
    expect(updated!.status).toBe('snoozed');
    expect(updated!.snoozedUntil).toBe(until);
  });

  it('registra el evento "snoozed" con actor + from/to (best-effort, Ola 2)', async () => {
    const { conversationRepo, eventRepo, uc } = makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 301, status: 'open' });

    await uc.execute(conv.id, futureIso(), 'user-7');

    const events = await eventRepo.listByConversation(conv.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'snoozed', actorId: 'user-7', fromValue: 'open', toValue: 'snoozed' });
  });

  it('snoozedUntil en el PASADO → InvalidSnoozeUntilError, SIN llamar a Chatwoot ni tocar el mirror', async () => {
    const { conversationRepo, gateway, uc } = makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 302, status: 'open' });

    await expect(uc.execute(conv.id, pastIso())).rejects.toBeInstanceOf(InvalidSnoozeUntilError);

    expect(gateway.setStatusCalls).toHaveLength(0);
    const stillOpen = await conversationRepo.findById(conv.id);
    expect(stillOpen!.status).toBe('open');
    expect(stillOpen!.snoozedUntil).toBeNull();
  });

  it('snoozedUntil inválido (no parseable) → InvalidSnoozeUntilError, SIN tocar Chatwoot', async () => {
    const { conversationRepo, gateway, uc } = makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 303, status: 'open' });

    await expect(uc.execute(conv.id, 'no-es-una-fecha')).rejects.toBeInstanceOf(InvalidSnoozeUntilError);
    expect(gateway.setStatusCalls).toHaveLength(0);
  });

  it('conversación inexistente → ConversationNotFoundError', async () => {
    const { uc } = makeHarness();
    await expect(uc.execute('ghost-id', futureIso())).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  it('Chatwoot inalcanzable → ChatwootUnavailableError, mirror NO se toca', async () => {
    const { conversationRepo, gateway, uc } = makeHarness();
    gateway.failSetStatus = true;
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 304, status: 'open' });

    await expect(uc.execute(conv.id, futureIso())).rejects.toBeInstanceOf(ChatwootUnavailableError);

    const stillOpen = await conversationRepo.findById(conv.id);
    expect(stillOpen!.status).toBe('open');
    expect(stillOpen!.snoozedUntil).toBeNull();
  });

  it('NUNCA toca canReply ni lastMessageAt/preview (posponer no reordena la lista ni reabre la ventana)', async () => {
    const { conversationRepo, uc } = makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({
      chatwootConversationId: 305,
      status: 'open',
      canReply: true,
      lastMessageAt: '2026-07-01T00:00:00.000Z',
      lastMessagePreview: 'ultimo real',
    });

    await uc.execute(conv.id, futureIso());

    const updated = await conversationRepo.findById(conv.id);
    expect(updated!.canReply).toBe(true);
    expect(updated!.lastMessageAt).toBe('2026-07-01T00:00:00.000Z');
    expect(updated!.lastMessagePreview).toBe('ultimo real');
  });

  it('best-effort: un fallo al registrar el evento NO tumba el snooze', async () => {
    const { conversationRepo, eventRepo, uc } = makeHarness();
    eventRepo.failRecord = true;
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 306, status: 'open' });

    await expect(uc.execute(conv.id, futureIso())).resolves.toMatchObject({ status: 'snoozed' });

    const updated = await conversationRepo.findById(conv.id);
    expect(updated!.status).toBe('snoozed');
    expect(updated!.snoozedUntil).not.toBeNull(); // el snooze SÍ se persiste (va en el upsert)
    expect(await eventRepo.listByConversation(conv.id)).toHaveLength(0); // el evento se perdió
  });
});
