/**
 * PrismaConversationRepository — adapter intention test with a mocked Prisma
 * client (patrón `PrismaContractPairingReader.where.test.ts`). Fix wave: §8 pins
 * the `orderBy` array actually sent to Prisma, so a future edit can't silently
 * drop the `id` tiebreaker (Postgres gives NO guarantee on row order for
 * `lastMessageAt` ties without a secondary ORDER BY key — this MUST mirror
 * `InMemoryConversationRepository.list`'s comparator exactly).
 */
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    conversation: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaConversationRepository } from '../../infrastructure/adapters/prisma/PrismaConversationRepository';

const mockPrisma = prisma as unknown as {
  conversation: { findMany: jest.Mock; count: jest.Mock };
};

describe('PrismaConversationRepository — list (§8: orderBy con tiebreaker id ASC)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.conversation.findMany.mockResolvedValue([]);
    mockPrisma.conversation.count.mockResolvedValue(0);
  });

  it('orderBy: lastMessageAt DESC NULLS LAST + id ASC (tiebreaker determinístico en empates)', async () => {
    const repo = new PrismaConversationRepository();
    await repo.list({ page: 1, limit: 25 });

    const call = mockPrisma.conversation.findMany.mock.calls[0][0];
    expect(call.orderBy).toEqual([{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }]);
  });
});
