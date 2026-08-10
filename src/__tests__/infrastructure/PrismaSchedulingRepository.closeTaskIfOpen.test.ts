/**
 * TDD — wave-1a (cierre atómico first-writer-wins) — PrismaSchedulingRepository.closeTaskIfOpen.
 *
 * One atomic `updateMany({ where: { id, generalStatus: { not: 'closed' } } })` — the
 * `WHERE` predicate takes the Postgres row lock, so a concurrent second writer
 * re-evaluates it against the already-committed value and matches 0 rows. No DB is
 * reachable in this apply phase (see the top-of-file note in
 * PrismaSchedulingRepository.ts), so — same convention as
 * PrismaSchedulingRepository.methods.test.ts — the prisma singleton is mocked and we
 * assert the adapter's own conditional logic: count===1 → won (re-reads + returns the
 * task); count===0 → lost (re-reads to report who won).
 */

// Mock the prisma singleton BEFORE importing anything that uses it.
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    scheduledTask: {
      updateMany: jest.fn(),
      findUnique: jest.fn(),
    },
  },
}));

import { PrismaSchedulingRepository } from '../../infrastructure/adapters/prisma/PrismaSchedulingRepository';
import { prisma } from '../../infrastructure/database/prisma';

const mockPrisma = prisma as unknown as {
  scheduledTask: { updateMany: jest.Mock; findUnique: jest.Mock };
};

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    sequenceNumber: 1,
    title: 'Test',
    description: null,
    stageId: 'stage-1',
    stage: { id: 'stage-1', category: 'nuevo' },
    priority: 'normal',
    estimatedHours: 1,
    address: null,
    lat: null,
    lng: null,
    category: 'other',
    projectId: null,
    project: null,
    completedAt: null,
    notes: null,
    startDate: null,
    endDate: null,
    customerId: null,
    customer: null,
    contractId: null,
    contract: null,
    partnerId: null,
    reporterId: null,
    reporter: null,
    assigneeId: null,
    assignee: null,
    travelTimeTo: null,
    travelTimeFrom: null,
    watchers: [],
    checklist: [],
    generalStatus: 'closed',
    isClosed: true,
    closureOrigin: null,
    closureResultCode: null,
    reviewedByInventory: false,
    reviewedByInventoryAt: null,
    reviewedByInventoryUser: null,
    closureCommentDone: false,
    closureAuditDone: false,
    closureHasDeviceInventory: false,
    iclassOrderCode: null,
    grOrdenId: null,
    ticketId: null,
    ticket: null,
    kind: 'customer',
    networkType: null,
    networkSiteId: null,
    networkSite: null,
    iclassCityCode: null,
    iclassStatusCode: null,
    iclassStatusUpdatedAt: null,
    onuSerial: null,
    archivedAt: null,
    lastBroadcastAt: null,
    lastBroadcastByName: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

afterEach(() => {
  jest.resetAllMocks();
});

describe('PrismaSchedulingRepository.closeTaskIfOpen', () => {
  it('count===1 → won: re-reads and returns closed=true with the fresh task DTO', async () => {
    mockPrisma.scheduledTask.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.scheduledTask.findUnique.mockResolvedValue(
      baseRow({ generalStatus: 'closed', isClosed: true, closureOrigin: 'app', closureResultCode: 'INSTALACION_OK' }),
    );

    const repo = new PrismaSchedulingRepository();
    const result = await repo.closeTaskIfOpen('task-1', { origin: 'app', resultCode: 'INSTALACION_OK', closedByUserId: 'u-1' });

    expect(result.closed).toBe(true);
    expect(result.task).not.toBeNull();
    expect(result.task!.generalStatus).toBe('closed');
    expect(result.task!.closureOrigin).toBe('app');
    expect(result.existingOrigin).toBeNull();
    expect(result.existingResultCode).toBeNull();

    // The atomic WHERE guard is the one thing that MUST be in the call — this is the
    // whole point of the method (no separate getTask + updateTask).
    expect(mockPrisma.scheduledTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'task-1', generalStatus: { not: 'closed' } },
        data: expect.objectContaining({
          generalStatus: 'closed',
          isClosed: true,
          closureOrigin: 'app',
          closureResultCode: 'INSTALACION_OK',
          closedByUserId: 'u-1',
        }),
      }),
    );
  });

  it('count===0 → lost: re-reads and returns closed=false with the WINNER origin/resultCode', async () => {
    mockPrisma.scheduledTask.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.scheduledTask.findUnique.mockResolvedValue(
      baseRow({ generalStatus: 'closed', isClosed: true, closureOrigin: 'iclass', closureResultCode: 'REAGENDADO' }),
    );

    const repo = new PrismaSchedulingRepository();
    const result = await repo.closeTaskIfOpen('task-1', { origin: 'app', resultCode: 'INSTALACION_OK' });

    expect(result.closed).toBe(false);
    expect(result.existingOrigin).toBe('iclass');
    expect(result.existingResultCode).toBe('REAGENDADO');
    // The loser's own input never leaks into the result.
    expect(result.task!.closureOrigin).toBe('iclass');
  });

  it('count===0 and the task no longer exists → closed=false with nulls (never throws)', async () => {
    mockPrisma.scheduledTask.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.scheduledTask.findUnique.mockResolvedValue(null);

    const repo = new PrismaSchedulingRepository();
    const result = await repo.closeTaskIfOpen('gone', { origin: 'staff' });

    expect(result.closed).toBe(false);
    expect(result.task).toBeNull();
    expect(result.existingOrigin).toBeNull();
    expect(result.existingResultCode).toBeNull();
  });
});
