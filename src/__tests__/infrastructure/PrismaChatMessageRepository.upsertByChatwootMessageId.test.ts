/**
 * chatwoot-hub-sendpath (D5, B3.4) — adapter intention test with a mocked Prisma
 * client (molde `PrismaChatMessageRepository.upsertTemplateMessage.test.ts`). Pins
 * que `idempotencyKey` viaja SET-ONCE en `upsertByChatwootMessageId`: el `create`
 * la incluye (o `null` si ausente), el `update` NUNCA la toca — así el eco
 * idempotente del webhook (`message_created`, que no manda la key) jamás la pisa.
 * Misma semántica que `InMemoryChatMessageRepository.upsertByChatwootMessageId`,
 * ambos adapters NO pueden divergir.
 */
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    chatMessage: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
    },
    $executeRaw: jest.fn(),
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaChatMessageRepository } from '../../infrastructure/adapters/prisma/PrismaChatMessageRepository';

const mockPrisma = prisma as unknown as {
  chatMessage: { upsert: jest.Mock; findUnique: jest.Mock };
  $executeRaw: jest.Mock;
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    chatwootMessageId: 555,
    origin: 'chatwoot',
    campaignRecipientId: null,
    providerMessageId: null,
    idempotencyKey: null,
    direction: 'outbound',
    content: 'Hola Juan, debés $5.000',
    senderName: null,
    chatwootCreatedAt: new Date('2026-07-21T10:00:00.000Z'),
    createdAt: new Date('2026-07-21T10:00:00.000Z'),
    isPrivate: false,
    authorId: null,
    editedAt: null,
    deletedAt: null,
    deliveryStatus: null,
    deliveryError: null,
    ...overrides,
  };
}

describe('PrismaChatMessageRepository — upsertByChatwootMessageId (D5, idempotencyKey set-once)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('create incluye idempotencyKey cuando el input lo trae', async () => {
    mockPrisma.chatMessage.findUnique.mockResolvedValue(null); // sin edición local previa
    mockPrisma.chatMessage.upsert.mockResolvedValue(row({ idempotencyKey: 'idem-1' }));

    const repo = new PrismaChatMessageRepository();
    const result = await repo.upsertByChatwootMessageId({
      conversationId: 'conv-1',
      chatwootMessageId: 555,
      direction: 'outbound',
      content: 'Hola Juan, debés $5.000',
      chatwootCreatedAt: '2026-07-21T10:00:00.000Z',
      idempotencyKey: 'idem-1',
    });

    const call = mockPrisma.chatMessage.upsert.mock.calls[0][0];
    expect(call.create).toEqual(expect.objectContaining({ idempotencyKey: 'idem-1' }));
    expect(result.idempotencyKey).toBe('idem-1');
  });

  it('idempotencyKey ausente en el create → manda null explícito', async () => {
    mockPrisma.chatMessage.findUnique.mockResolvedValue(null);
    mockPrisma.chatMessage.upsert.mockResolvedValue(row());

    const repo = new PrismaChatMessageRepository();
    await repo.upsertByChatwootMessageId({
      conversationId: 'conv-1',
      chatwootMessageId: 555,
      direction: 'outbound',
      content: 'Hola Juan, debés $5.000',
      chatwootCreatedAt: '2026-07-21T10:00:00.000Z',
    });

    const call = mockPrisma.chatMessage.upsert.mock.calls[0][0];
    expect(call.create).toEqual(expect.objectContaining({ idempotencyKey: null }));
  });

  it('el `update` NUNCA incluye idempotencyKey (set-once — el eco del webhook no puede pisarla)', async () => {
    mockPrisma.chatMessage.findUnique.mockResolvedValue(null);
    mockPrisma.chatMessage.upsert.mockResolvedValue(row({ content: 'echo', idempotencyKey: 'idem-1' }));

    const repo = new PrismaChatMessageRepository();
    await repo.upsertByChatwootMessageId({
      conversationId: 'conv-1',
      chatwootMessageId: 555,
      direction: 'outbound',
      content: 'echo',
      chatwootCreatedAt: '2026-07-21T10:05:00.000Z',
      // sin idempotencyKey — simula el eco de message_created del webhook.
    });

    const call = mockPrisma.chatMessage.upsert.mock.calls[0][0];
    expect(call.update).not.toHaveProperty('idempotencyKey');
  });
});
