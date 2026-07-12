/**
 * PrismaChatMessageRepository — adapter intention test with a mocked Prisma
 * client (patrón `PrismaContractPairingReader.where.test.ts`). Fix wave: §8 pins
 * the `orderBy` array actually sent to Prisma, so a future edit can't silently
 * drop the `id` tiebreaker (Postgres gives NO guarantee on row order for
 * `chatwootCreatedAt` ties without a secondary ORDER BY key — this MUST mirror
 * `InMemoryChatMessageRepository.listByConversation`'s comparator exactly).
 */
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    chatMessage: {
      findMany: jest.fn(),
    },
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaChatMessageRepository } from '../../infrastructure/adapters/prisma/PrismaChatMessageRepository';

const mockPrisma = prisma as unknown as {
  chatMessage: { findMany: jest.Mock };
};

describe('PrismaChatMessageRepository — listByConversation (§8: orderBy con tiebreaker id ASC)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.chatMessage.findMany.mockResolvedValue([]);
  });

  it('orderBy: chatwootCreatedAt ASC + id ASC (tiebreaker determinístico en empates)', async () => {
    const repo = new PrismaChatMessageRepository();
    await repo.listByConversation('conv-1');

    const call = mockPrisma.chatMessage.findMany.mock.calls[0][0];
    expect(call.orderBy).toEqual([{ chatwootCreatedAt: 'asc' }, { id: 'asc' }]);
  });
});
