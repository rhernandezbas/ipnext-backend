/**
 * chatwoot-hub-sendpath (D6, B5.2) — adapter intention test con Prisma mockeado
 * (molde `PrismaChatMessageRepository.upsertByChatwootMessageId.test.ts`). Pinea que
 * `markDeliveryFailedByChatwootMessageId` actualiza EXCLUSIVAMENTE `deliveryStatus`/
 * `deliveryError` por `chatwootMessageId` (nunca por `id`), y que una fila ausente
 * (P2025) resuelve a `null` sin lanzar — mismo criterio LOW-3 que `updateContent`/
 * `softDelete`. Cross-ref: `InMemoryChatMessageRepository.markDeliveryFailedByChatwootMessageId`,
 * ambos adapters NO pueden divergir.
 */
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    chatMessage: {
      update: jest.fn(),
    },
    $executeRaw: jest.fn(),
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaChatMessageRepository } from '../../infrastructure/adapters/prisma/PrismaChatMessageRepository';

const mockPrisma = prisma as unknown as {
  chatMessage: { update: jest.Mock };
  $executeRaw: jest.Mock;
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    chatwootMessageId: 777,
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

describe('PrismaChatMessageRepository — markDeliveryFailedByChatwootMessageId (D6, CHW-5)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('actualiza por chatwootMessageId (where), con deliveryStatus/deliveryError EXACTOS', async () => {
    mockPrisma.chatMessage.update.mockResolvedValue(
      row({ deliveryStatus: 'failed', deliveryError: 'Template not found' }),
    );

    const repo = new PrismaChatMessageRepository();
    const result = await repo.markDeliveryFailedByChatwootMessageId(777, 'Template not found');

    expect(mockPrisma.chatMessage.update).toHaveBeenCalledWith({
      where: { chatwootMessageId: 777 },
      data: { deliveryStatus: 'failed', deliveryError: 'Template not found' },
    });
    expect(result!.deliveryStatus).toBe('failed');
    expect(result!.deliveryError).toBe('Template not found');
  });

  it('fila ausente (P2025) → null, sin lanzar', async () => {
    mockPrisma.chatMessage.update.mockRejectedValue({ code: 'P2025' });

    const repo = new PrismaChatMessageRepository();
    const result = await repo.markDeliveryFailedByChatwootMessageId(99999, 'Template not found');

    expect(result).toBeNull();
  });

  it('cualquier otro error propaga (no se absorbe silenciosamente)', async () => {
    mockPrisma.chatMessage.update.mockRejectedValue(new Error('db hipo'));

    const repo = new PrismaChatMessageRepository();
    await expect(repo.markDeliveryFailedByChatwootMessageId(777, 'x')).rejects.toThrow('db hipo');
  });
});
