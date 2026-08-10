/**
 * TDD — wave-1a (cierre atómico) — toTask() maps closureOrigin (spec: task-general-status,
 * "Response shape includes closureOrigin" / "Open task has null closureOrigin").
 */
import { toTask } from '../../infrastructure/adapters/prisma/PrismaSchedulingRepository';

const BASE_ROW = {
  id: 'test-1',
  sequenceNumber: 1,
  title: 'Test task',
  description: null,
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
  stageId: 'stage-1',
  stage: { id: 'stage-1', name: 'Nuevo', category: 'nuevo' },
  startDate: null,
  endDate: null,
  customerId: null,
  customer: null,
  partnerId: null,
  reporterId: null,
  assigneeId: null,
  assignee: null,
  watchers: [],
  checklist: [],
  travelTimeTo: null,
  travelTimeFrom: null,
  createdAt: new Date('2026-05-01T00:00:00Z'),
  updatedAt: new Date('2026-05-01T00:00:00Z'),
};

describe('PrismaSchedulingRepository.toTask — closureOrigin (wave-1a)', () => {
  it('Scenario: Open task has null closureOrigin', () => {
    const task = toTask({ ...BASE_ROW, generalStatus: 'open', isClosed: false, closureOrigin: null });
    expect(task.generalStatus).toBe('open');
    expect(task.closureOrigin).toBeNull();
  });

  it('Scenario: Response shape includes closureOrigin — closed task carries the winning origin', () => {
    const task = toTask({ ...BASE_ROW, generalStatus: 'closed', isClosed: true, closureOrigin: 'iclass' });
    expect(task.isClosed).toBe(true);
    expect(task.closureOrigin).toBe('iclass');
  });

  it('legacy row (closed BEFORE this migration) — closureOrigin is null, no invented backfill', () => {
    // No closureOrigin key at all — the column existed as NULL for pre-migration rows.
    const task = toTask({ ...BASE_ROW, generalStatus: 'closed', isClosed: true });
    expect(task.generalStatus).toBe('closed');
    expect(task.closureOrigin).toBeNull();
  });
});
