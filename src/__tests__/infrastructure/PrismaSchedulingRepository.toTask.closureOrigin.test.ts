/**
 * wave-1a (cierre atómico) — toTask() maps closureOrigin (spec: task-general-status,
 * "Response shape includes closureOrigin" / "Open task has null closureOrigin").
 *
 * FIX WAVE / FIX-1 — the first version of this file fed `closureOrigin: null` and
 * asserted `null`: TAUTOLOGICAL. Feeding the expected answer in and reading it back
 * out survives every mutant except one that invents data. Rewritten so each case
 * DISCRIMINATES:
 *   - three DISTINCT origins round-trip → kills a hardcoded/constant mapper;
 *   - a row with NO `closureOrigin` key → must be `null`, not `undefined` → kills a
 *     bare `row.closureOrigin` passthrough (the DTO contract is nullable, not optional);
 *   - the spec invariant "closureOrigin is null unless generalStatus === 'closed'" is
 *     NOT asserted here (a pure mapper cannot enforce it) — it is enforced by the
 *     WRITE path and pinned in PrismaSchedulingRepository.reopenClearsClosure.test.ts
 *     + InMemorySchedulingRepository.reopenClearsClosure.test.ts. Pointer kept on
 *     purpose so nobody re-adds a fake echo test here believing it covers the spec.
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
  it.each(['app', 'iclass', 'staff'] as const)(
    'Scenario: Response shape includes closureOrigin — a closed row carries origin=%s VERBATIM (no constant, no default)',
    (origin) => {
      const task = toTask({ ...BASE_ROW, generalStatus: 'closed', isClosed: true, closureOrigin: origin });
      expect(task.isClosed).toBe(true);
      expect(task.closureOrigin).toBe(origin);
    },
  );

  it('the three origins produce three DIFFERENT DTOs (a constant mapper would collapse them)', () => {
    const origins = (['app', 'iclass', 'staff'] as const).map(o =>
      toTask({ ...BASE_ROW, generalStatus: 'closed', isClosed: true, closureOrigin: o }).closureOrigin,
    );
    expect(new Set(origins).size).toBe(3);
  });

  it('legacy row (closed BEFORE this migration): NO closureOrigin key → null, never undefined', () => {
    const task = toTask({ ...BASE_ROW, generalStatus: 'closed', isClosed: true });
    expect(task.generalStatus).toBe('closed');
    // `toBeNull` (not `toBeUndefined`/`toBeFalsy`): a bare `row.closureOrigin` passthrough
    // yields `undefined` and would serialize the key OUT of the JSON response entirely.
    expect(task.closureOrigin).toBeNull();
    expect('closureOrigin' in task).toBe(true);
  });

  it('Scenario: Open task has null closureOrigin — and the open DTO differs from a closed one', () => {
    const open = toTask({ ...BASE_ROW, generalStatus: 'open', isClosed: false, closureOrigin: null });
    const closed = toTask({ ...BASE_ROW, generalStatus: 'closed', isClosed: true, closureOrigin: 'staff' });
    expect(open.generalStatus).toBe('open');
    expect(open.closureOrigin).toBeNull();
    expect(closed.closureOrigin).not.toBe(open.closureOrigin);
  });
});
