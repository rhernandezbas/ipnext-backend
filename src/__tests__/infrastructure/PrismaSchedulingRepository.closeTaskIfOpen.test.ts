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
    $transaction: jest.fn(),
  },
}));

import { PrismaSchedulingRepository } from '../../infrastructure/adapters/prisma/PrismaSchedulingRepository';
import { prisma } from '../../infrastructure/database/prisma';

const mockPrisma = prisma as unknown as {
  scheduledTask: { updateMany: jest.Mock; findUnique: jest.Mock };
  $transaction: jest.Mock;
};

// FIX-5 (fix wave W1a) — closeTaskIfOpen now runs its two statements inside ONE
// interactive `$transaction`, i.e. on ONE connection. The tx client handed to the
// callback gets its OWN spies so a test can prove the statements ran THERE and not on
// the global (pooled, possibly different-connection) client.
const tx = {
  scheduledTask: { updateMany: jest.fn(), findUnique: jest.fn() },
};

beforeEach(() => {
  mockPrisma.$transaction.mockImplementation(async (cb: (t: unknown) => unknown) => cb(tx));
});

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
  tx.scheduledTask.updateMany.mockReset();
  tx.scheduledTask.findUnique.mockReset();
});

describe('PrismaSchedulingRepository.closeTaskIfOpen', () => {
  it('count===1 → won: re-reads and returns closed=true with the fresh task DTO', async () => {
    tx.scheduledTask.updateMany.mockResolvedValue({ count: 1 });
    tx.scheduledTask.findUnique.mockResolvedValue(
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
    expect(tx.scheduledTask.updateMany).toHaveBeenCalledWith(
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
    tx.scheduledTask.updateMany.mockResolvedValue({ count: 0 });
    tx.scheduledTask.findUnique.mockResolvedValue(
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
    tx.scheduledTask.updateMany.mockResolvedValue({ count: 0 });
    tx.scheduledTask.findUnique.mockResolvedValue(null);

    const repo = new PrismaSchedulingRepository();
    const result = await repo.closeTaskIfOpen('gone', { origin: 'staff' });

    expect(result.closed).toBe(false);
    expect(result.task).toBeNull();
    expect(result.existingOrigin).toBeNull();
    expect(result.existingResultCode).toBeNull();
  });
});

/**
 * FIX-5 (fix wave W1a) — the guard and the re-read are ONE unit of work.
 *
 * `updateMany` (the atomic guard) and the `findUnique` that reports the outcome used to
 * be two independent round-trips: two pool connections, two commits' worth of gap in
 * between. Concretely, on a WIN the UPDATE committed immediately, and a third writer
 * could reopen + re-close the task before our re-read landed — the method would then
 * return `closed: true` carrying SOMEBODY ELSE'S closureOrigin/closedAt, i.e. attribute
 * another origin's closure to this caller. Wrapping both in an interactive
 * `$transaction` pins them to one connection and holds the row lock the UPDATE took
 * until commit, so the re-read on a win is guaranteed to observe exactly our own write.
 *
 * (Chosen over `UPDATE ... RETURNING` via `$queryRaw`: RETURNING would hand-roll the
 * column list and the `INCLUDE` JOINs that `toTask` needs — stage/customer/assignee/
 * watchers/checklist — duplicating the mapping and rotting on the next schema change.
 * Residual, documented: in the LOSING case our UPDATE matched no row and therefore took
 * no lock, so under READ COMMITTED the reported winner is still a fresh read. That is
 * inherent — there is no winner of ours to pin — and harmless: the reported winner is
 * simply the most recent one.)
 */
describe('PrismaSchedulingRepository.closeTaskIfOpen — single unit of work (FIX-5)', () => {
  it('runs the guard AND the re-read inside ONE $transaction, on the tx client', async () => {
    tx.scheduledTask.updateMany.mockResolvedValue({ count: 1 });
    tx.scheduledTask.findUnique.mockResolvedValue(
      baseRow({ generalStatus: 'closed', isClosed: true, closureOrigin: 'app', closureResultCode: 'OK' }),
    );

    const repo = new PrismaSchedulingRepository();
    await repo.closeTaskIfOpen('task-1', { origin: 'app', resultCode: 'OK' });

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.scheduledTask.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.scheduledTask.findUnique).toHaveBeenCalledTimes(1);
    // Neither statement leaked onto the global (pooled) client.
    expect(mockPrisma.scheduledTask.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.scheduledTask.findUnique).not.toHaveBeenCalled();
  });

  it('the losing path is inside the SAME transaction too (not just the winning one)', async () => {
    tx.scheduledTask.updateMany.mockResolvedValue({ count: 0 });
    tx.scheduledTask.findUnique.mockResolvedValue(
      baseRow({ generalStatus: 'closed', isClosed: true, closureOrigin: 'staff', closureResultCode: 'CANCELADO' }),
    );

    const repo = new PrismaSchedulingRepository();
    const result = await repo.closeTaskIfOpen('task-1', { origin: 'iclass', resultCode: 'REAGENDADO' });

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(result.existingOrigin).toBe('staff');
    expect(mockPrisma.scheduledTask.findUnique).not.toHaveBeenCalled();
  });

  it('the atomic write stamps closedAt as a real Date (FIX-6a — the mutant that drops it)', async () => {
    tx.scheduledTask.updateMany.mockResolvedValue({ count: 1 });
    tx.scheduledTask.findUnique.mockResolvedValue(baseRow({ closureOrigin: 'staff' }));

    const repo = new PrismaSchedulingRepository();
    await repo.closeTaskIfOpen('task-1', { origin: 'staff', resultCode: null, closedByUserId: 'u-9' });

    const data = (tx.scheduledTask.updateMany.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data['closedAt']).toBeInstanceOf(Date);
    expect(data['closedByUserId']).toBe('u-9');
    expect(data['closureResultCode']).toBeNull();
  });
});
