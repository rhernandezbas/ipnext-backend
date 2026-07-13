/**
 * messaging-inbox-productivity (F1.5 fase C, STATUS-1) — SetConversationStatus:
 * resolver/reabrir/pendiente desde el inbox. Gateado por el MISMO permiso que
 * SendMessage (`messaging:send`, ver messaging.routes.ts). `status` es
 * INDEPENDIENTE de `canReply` (la ventana de 24h) — esta use case JAMÁS toca
 * `canReply` ni recalcula la ventana.
 *
 * Uses `FakeChatwootGateway` (helpers/) instead of mocking axios/Prisma — same
 * "test double over the port" convention as `SendMessage.test.ts`.
 */
import { SetConversationStatus } from '@application/use-cases/messaging/SetConversationStatus';
import {
  ConversationNotFoundError,
  ChatwootUnavailableError,
  InvalidConversationStatusError,
} from '@domain/errors/messaging';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { FakeChatwootGateway } from '../../helpers/FakeChatwootGateway';

function makeHarness() {
  const conversationRepo = new InMemoryConversationRepository();
  const gateway = new FakeChatwootGateway();
  const uc = new SetConversationStatus(conversationRepo, gateway);
  return { conversationRepo, gateway, uc };
}

describe('SetConversationStatus', () => {
  it('STATUS-1: status válido → llama gateway.setStatus con el chatwootConversationId correcto y el status, actualiza el mirror, y devuelve el DTO actualizado', async () => {
    const { conversationRepo, gateway, uc } = makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 100, status: 'open' });

    const result = await uc.execute(conv.id, 'resolved');

    expect(gateway.setStatusCalls).toEqual([{ chatwootConversationId: 100, status: 'resolved' }]);
    expect(result).toMatchObject({ id: conv.id, status: 'resolved' });

    const updated = await conversationRepo.findById(conv.id);
    expect(updated!.status).toBe('resolved');
  });

  it.each(['open', 'resolved', 'pending'])('acepta el status válido "%s"', async (status) => {
    const { conversationRepo, gateway, uc } = makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 101, status: 'open' });

    await uc.execute(conv.id, status);

    expect(gateway.setStatusCalls[0]).toMatchObject({ chatwootConversationId: 101, status });
  });

  it('status inválido → InvalidConversationStatusError, SIN llamar a Chatwoot ni tocar el mirror', async () => {
    const { conversationRepo, gateway, uc } = makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 102, status: 'open' });

    await expect(uc.execute(conv.id, 'closed')).rejects.toBeInstanceOf(InvalidConversationStatusError);

    expect(gateway.setStatusCalls).toHaveLength(0);
    const stillOpen = await conversationRepo.findById(conv.id);
    expect(stillOpen!.status).toBe('open');
  });

  it('status vacío/ausente → InvalidConversationStatusError', async () => {
    const { conversationRepo, gateway, uc } = makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 103 });

    await expect(uc.execute(conv.id, '')).rejects.toBeInstanceOf(InvalidConversationStatusError);
    expect(gateway.setStatusCalls).toHaveLength(0);
  });

  it('conversación inexistente → ConversationNotFoundError', async () => {
    const { uc } = makeHarness();

    await expect(uc.execute('ghost-id', 'resolved')).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  it('Chatwoot inalcanzable → ChatwootUnavailableError, mirror NO se toca', async () => {
    const { conversationRepo, gateway, uc } = makeHarness();
    gateway.failSetStatus = true;
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 104, status: 'open' });

    await expect(uc.execute(conv.id, 'resolved')).rejects.toBeInstanceOf(ChatwootUnavailableError);

    const stillOpen = await conversationRepo.findById(conv.id);
    expect(stillOpen!.status).toBe('open');
  });

  it('actualiza status del mirror POST-OK pero NUNCA bumpea lastMessagePreview/lastMessageAt (cambiar estado no reordena la lista)', async () => {
    const { conversationRepo, uc } = makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({
      chatwootConversationId: 105,
      status: 'open',
      lastMessageAt: '2026-07-01T00:00:00.000Z',
      lastMessagePreview: 'ultimo mensaje real',
    });

    await uc.execute(conv.id, 'resolved');

    const updated = await conversationRepo.findById(conv.id);
    expect(updated!.status).toBe('resolved');
    expect(updated!.lastMessageAt).toBe('2026-07-01T00:00:00.000Z');
    expect(updated!.lastMessagePreview).toBe('ultimo mensaje real');
  });

  it('NUNCA toca canReply (independiente de la ventana de 24h) — reabrir no reabre la ventana', async () => {
    const { conversationRepo, uc } = makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({
      chatwootConversationId: 106,
      status: 'resolved',
      canReply: false,
    });

    await uc.execute(conv.id, 'open');

    const updated = await conversationRepo.findById(conv.id);
    expect(updated!.status).toBe('open');
    expect(updated!.canReply).toBe(false); // NOT reopened by a status change
  });
});
