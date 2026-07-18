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

describe('PrismaConversationRepository — list (inbox-resolve LS-1: where del filtro ?status=)', () => {
  // conversation-snooze (Ola 6c) — el bucket ACTIVAS excluye las POSPUESTAS VIGENTES vía un OR
  // NULL-safe (una snoozed vencida o con snoozedUntil null SÍ cuenta como open). `now` es dinámico
  // (`new Date()` en el builder) → `expect.any(Date)` en el `lte`.
  const notVigenteSnoozed = [
    { status: { not: 'snoozed' } },
    { snoozedUntil: null },
    { snoozedUntil: { lte: expect.any(Date) } },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.conversation.findMany.mockResolvedValue([]);
    mockPrisma.conversation.count.mockResolvedValue(0);
  });

  it("status: 'open' → where.status = { not: 'resolved' } + OR (excluye pospuestas vigentes; MISMO where en findMany y count)", async () => {
    const repo = new PrismaConversationRepository();
    await repo.list({ status: 'open', page: 1, limit: 25 });

    const findManyWhere = mockPrisma.conversation.findMany.mock.calls[0][0].where;
    const countWhere = mockPrisma.conversation.count.mock.calls[0][0].where;
    expect(findManyWhere).toEqual({ status: { not: 'resolved' }, OR: notVigenteSnoozed });
    expect(countWhere).toEqual({ status: { not: 'resolved' }, OR: notVigenteSnoozed });
  });

  it("status: 'resolved' → where.status = 'resolved' (match exacto)", async () => {
    const repo = new PrismaConversationRepository();
    await repo.list({ status: 'resolved', page: 1, limit: 25 });

    const findManyWhere = mockPrisma.conversation.findMany.mock.calls[0][0].where;
    expect(findManyWhere).toEqual({ status: 'resolved' });
  });

  it('status ausente → where NO agrega la clave status (no-regresión)', async () => {
    const repo = new PrismaConversationRepository();
    await repo.list({ page: 1, limit: 25 });

    const findManyWhere = mockPrisma.conversation.findMany.mock.calls[0][0].where;
    expect(findManyWhere).not.toHaveProperty('status');
  });

  it("combinable: status='open' + assigneeId → AND de ambas claves en el where", async () => {
    const repo = new PrismaConversationRepository();
    await repo.list({ status: 'open', assigneeId: 'user-1', page: 1, limit: 25 });

    const findManyWhere = mockPrisma.conversation.findMany.mock.calls[0][0].where;
    expect(findManyWhere).toEqual({ assigneeId: 'user-1', status: { not: 'resolved' }, OR: notVigenteSnoozed });
  });
});
