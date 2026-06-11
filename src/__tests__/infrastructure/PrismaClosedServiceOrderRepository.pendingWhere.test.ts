/**
 * PrismaClosedServiceOrderRepository — adapter unit tests with mocked Prisma client.
 *
 * Purpose: pin the WHERE shape of the dismissed-task exclusion in
 * listPendingSideEffects() (:301) and listPendingSideEffectsWithTask() (:333).
 *
 * The bug the in-memory CANNOT catch: a negated nullable to-one relation
 * (`NOT: { scheduledTask: { generalStatus: 'dismissed' } }`) is FALSE for rows
 * whose relation is null under Prisma 1:1 semantics (prisma/prisma#25226), so
 * null-task mirrors get silently EXCLUDED — contradicting in-memory parity
 * (isDismissed keeps null-task SOs). This is pure SQL-path behavior; the
 * in-memory port can't exercise it, so we pin the QUERY SHAPE here.
 *
 * Truth table the fix must honor:
 *   - null-task   → leg 1 (scheduledTaskId: null) TRUE  → kept
 *   - task=dismissed → both legs FALSE                  → excluded
 *   - task=other  → leg 2 (generalStatus not dismissed) TRUE → kept
 *
 * Pattern mirrors PrismaNetworkSiteRepository.test.ts (jest.mock at module level).
 */

// Mock the prisma singleton before importing the repository
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    iClassServiceOrder: {
      findMany: jest.fn(),
    },
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaClosedServiceOrderRepository } from '../../infrastructure/adapters/prisma/PrismaClosedServiceOrderRepository';

const mockPrisma = prisma as unknown as {
  iClassServiceOrder: { findMany: jest.Mock };
};

describe('PrismaClosedServiceOrderRepository — dismissed exclusion WHERE shape', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.iClassServiceOrder.findMany.mockResolvedValue([]);
  });

  it('listPendingSideEffects() keeps null-task SOs via OR scheduledTaskId:null leg', async () => {
    const repo = new PrismaClosedServiceOrderRepository();
    await repo.listPendingSideEffects(3);

    expect(mockPrisma.iClassServiceOrder.findMany).toHaveBeenCalledTimes(1);
    const where = mockPrisma.iClassServiceOrder.findMany.mock.calls[0][0].where;

    // The dismissed exclusion must be expressed as an OR with the null leg,
    // NOT as a bare negated nullable relation (which would drop null-task rows).
    expect(where.AND).toEqual(
      expect.arrayContaining([
        {
          OR: [
            { scheduledTaskId: null },
            { scheduledTask: { generalStatus: { not: 'dismissed' } } },
          ],
        },
      ]),
    );

    // And the legacy buggy shape must be gone.
    expect(where).not.toHaveProperty('NOT');
  });

  it('listPendingSideEffectsWithTask() keeps null-task SOs via OR scheduledTaskId:null leg', async () => {
    const repo = new PrismaClosedServiceOrderRepository();
    await repo.listPendingSideEffectsWithTask(3);

    expect(mockPrisma.iClassServiceOrder.findMany).toHaveBeenCalledTimes(1);
    const where = mockPrisma.iClassServiceOrder.findMany.mock.calls[0][0].where;

    expect(where.AND).toEqual(
      expect.arrayContaining([
        {
          OR: [
            { scheduledTaskId: null },
            { scheduledTask: { generalStatus: { not: 'dismissed' } } },
          ],
        },
      ]),
    );

    expect(where).not.toHaveProperty('NOT');
  });

  it('preserves the pending side-effects OR (commentPosted/inventoryBuilt/auditDone) in both methods', async () => {
    const repo = new PrismaClosedServiceOrderRepository();

    await repo.listPendingSideEffects(5);
    const where1 = mockPrisma.iClassServiceOrder.findMany.mock.calls[0][0].where;
    expect(where1.AND).toEqual(
      expect.arrayContaining([
        {
          OR: [
            { commentPosted: false },
            { inventoryBuilt: false },
            { auditDone: false, auditAttempts: { lt: 5 } },
          ],
        },
      ]),
    );

    mockPrisma.iClassServiceOrder.findMany.mockClear();

    await repo.listPendingSideEffectsWithTask(5);
    const where2 = mockPrisma.iClassServiceOrder.findMany.mock.calls[0][0].where;
    expect(where2.AND).toEqual(
      expect.arrayContaining([
        {
          OR: [
            { commentPosted: false },
            { inventoryBuilt: false },
            { auditDone: false, auditAttempts: { lt: 5 } },
          ],
        },
      ]),
    );
  });
});
