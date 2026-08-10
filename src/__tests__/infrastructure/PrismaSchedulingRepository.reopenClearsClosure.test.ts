/**
 * TDD — fix wave W1a / FIX-1 (Prisma twin) — reopening CLEARS the closure columns.
 *
 * Same invariant as InMemorySchedulingRepository.reopenClearsClosure.test.ts, asserted
 * on the OTHER adapter: the port has two implementations and a fix applied to only one
 * of them is exactly the "buscar el hermano" defect. No DB is reachable in this phase,
 * so — same convention as PrismaSchedulingRepository.methods.test.ts — the prisma
 * singleton is mocked and we assert the `data` payload the adapter builds.
 */

jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    scheduledTask: {
      update: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
    },
    taskWatcher: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

import { PrismaSchedulingRepository } from '../../infrastructure/adapters/prisma/PrismaSchedulingRepository';
import { prisma } from '../../infrastructure/database/prisma';

const mockPrisma = prisma as unknown as {
  scheduledTask: { update: jest.Mock; updateMany: jest.Mock; findUnique: jest.Mock };
  taskWatcher: { deleteMany: jest.Mock; createMany: jest.Mock };
  $transaction: jest.Mock;
};

const ROW = {
  id: 'task-1',
  sequenceNumber: 1,
  title: 'T',
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
  partnerId: null,
  reporterId: null,
  assigneeId: null,
  assignee: null,
  travelTimeTo: null,
  travelTimeFrom: null,
  watchers: [],
  checklist: [],
  generalStatus: 'open',
  isClosed: false,
  closureOrigin: null,
  closureResultCode: null,
  closedAt: null,
  closedByUserId: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

const CLEARED = {
  closureOrigin: null,
  closureResultCode: null,
  closedAt: null,
  closedByUserId: null,
};

beforeEach(() => {
  jest.resetAllMocks();
  mockPrisma.scheduledTask.update.mockResolvedValue(ROW);
  mockPrisma.scheduledTask.findUnique.mockResolvedValue(ROW);
});

function lastUpdateData(): Record<string, unknown> {
  const call = mockPrisma.scheduledTask.update.mock.calls.at(-1);
  return (call![0] as { data: Record<string, unknown> }).data;
}

describe('PrismaSchedulingRepository.updateTask — reopen clears the closure columns (FIX-1)', () => {
  it('generalStatus:\'open\' writes the 4 closure columns back to null', async () => {
    const repo = new PrismaSchedulingRepository();
    await repo.updateTask('task-1', { generalStatus: 'open' });

    const data = lastUpdateData();
    expect(data).toMatchObject({ generalStatus: 'open', isClosed: false, ...CLEARED });
  });

  it('legacy compat `isClosed:false` clears them too', async () => {
    const repo = new PrismaSchedulingRepository();
    await repo.updateTask('task-1', { isClosed: false });

    expect(lastUpdateData()).toMatchObject({ generalStatus: 'open', isClosed: false, ...CLEARED });
  });

  it('generalStatus:\'dismissed\' clears them too (ANY transition out of closed)', async () => {
    const repo = new PrismaSchedulingRepository();
    await repo.updateTask('task-1', { generalStatus: 'dismissed' });

    expect(lastUpdateData()).toMatchObject({ generalStatus: 'dismissed', isClosed: false, ...CLEARED });
  });

  it('the watcherIds branch (inside $transaction) clears them too — same _buildUpdateData', async () => {
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({
        scheduledTask: { update: mockPrisma.scheduledTask.update, findUnique: mockPrisma.scheduledTask.findUnique },
        taskWatcher: mockPrisma.taskWatcher,
      }),
    );

    const repo = new PrismaSchedulingRepository();
    await repo.updateTask('task-1', { generalStatus: 'open', watcherIds: [] });

    expect(lastUpdateData()).toMatchObject({ generalStatus: 'open', ...CLEARED });
  });

  it('an update that does NOT touch generalStatus leaves the closure columns ALONE (no key at all)', async () => {
    const repo = new PrismaSchedulingRepository();
    await repo.updateTask('task-1', { title: 'nuevo titulo' });

    const data = lastUpdateData();
    expect(data).toMatchObject({ title: 'nuevo titulo' });
    // Not "null" — ABSENT. Writing null here would wipe a legitimate closure stamp
    // on every unrelated PUT (the FE resubmits the full body on each save).
    expect(Object.keys(data)).not.toContain('closureOrigin');
    expect(Object.keys(data)).not.toContain('closedAt');
    expect(Object.keys(data)).not.toContain('closureResultCode');
    expect(Object.keys(data)).not.toContain('closedByUserId');
  });

  it('generalStatus:\'closed\' via updateTask does NOT stamp a closure (that is closeTaskIfOpen\'s job)', async () => {
    const repo = new PrismaSchedulingRepository();
    await repo.updateTask('task-1', { generalStatus: 'closed' });

    const data = lastUpdateData();
    expect(data).toMatchObject({ generalStatus: 'closed', isClosed: true });
    expect(Object.keys(data)).not.toContain('closureOrigin');
  });
});
