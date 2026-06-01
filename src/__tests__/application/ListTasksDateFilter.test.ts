/**
 * Unit tests for ListTasks date range filter (from / to).
 * TDD: tests written RED first, then implementation added.
 * Change: scheduling-calendar-view, Phase 1.4
 */
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { ListTasks } from '../../application/use-cases/ListTasks';
import { CreateTask } from '../../application/use-cases/CreateTask';
import { EntityLookup } from '../../domain/ports/EntityLookup';

class StubLookup implements EntityLookup {
  async findById(id: string) { return { id }; }
}
const emptyLookup = new StubLookup();

const DEFAULT_STAGE_ID = '10000000-0000-4000-a000-000000000001';

const BASE_TASK = {
  title: 'Test task',
  description: null as null,
  assignedTo: null as null,
  assignedToId: null as null,
  clientId: null as null,
  clientName: null as null,
  scheduledDate: null as null,
  scheduledTime: null as null,
  stageId: DEFAULT_STAGE_ID,
  priority: 'normal' as const,
  estimatedHours: 1,
  address: null as null,
  coordinates: null as null,
  category: 'repair' as const,
  projectId: null as null,
  projectName: null as null,
  completedAt: null as null,
  notes: null as null,
  startDate: null as null,
  endDate: null as null,
  customerId: null as null,
  contractId: null as null,
  partnerId: null as null,
  reporterId: null as null,
  assigneeId: null as null,
  watcherIds: [] as string[],
  travelTimeTo: null as null,
  travelTimeFrom: null as null,
};

async function buildRepo() {
  const repo = new InMemorySchedulingRepository();
  const createTask = new CreateTask(repo, emptyLookup, emptyLookup, emptyLookup, emptyLookup, emptyLookup);

  // Task A: startDate 2026-05-19
  await createTask.execute({ ...BASE_TASK, title: 'Task A - May 19', startDate: '2026-05-19T12:00:00Z' });
  // Task B: startDate 2026-05-20
  await createTask.execute({ ...BASE_TASK, title: 'Task B - May 20', startDate: '2026-05-20T09:00:00Z' });
  // Task C: startDate 2026-05-21
  await createTask.execute({ ...BASE_TASK, title: 'Task C - May 21', startDate: '2026-05-21T14:00:00Z' });
  // Task D: startDate null
  await createTask.execute({ ...BASE_TASK, title: 'Task D - no date', startDate: null });

  return repo;
}

describe('InMemorySchedulingRepository.listTasks — date range filter', () => {
  it('returns all tasks when no date filter is provided (backward compat)', async () => {
    const repo = await buildRepo();
    // 7 seeded + 4 added
    const tasks = await repo.listTasks();
    expect(tasks.length).toBe(11);
  });

  it('filters by from only — returns tasks with startDate >= from', async () => {
    const repo = await buildRepo();
    const tasks = await repo.listTasks({ from: '2026-05-20T00:00:00Z' });
    const titles = tasks.map(t => t.title);
    expect(titles).toContain('Task B - May 20');
    expect(titles).toContain('Task C - May 21');
    expect(titles).not.toContain('Task A - May 19');
    expect(titles).not.toContain('Task D - no date');
  });

  it('filters by to only — returns tasks with startDate <= to', async () => {
    const repo = await buildRepo();
    const tasks = await repo.listTasks({ to: '2026-05-20T23:59:59Z' });
    const titles = tasks.map(t => t.title);
    expect(titles).toContain('Task A - May 19');
    expect(titles).toContain('Task B - May 20');
    expect(titles).not.toContain('Task C - May 21');
    expect(titles).not.toContain('Task D - no date');
  });

  it('filters by both from and to — returns tasks in range', async () => {
    const repo = await buildRepo();
    const tasks = await repo.listTasks({
      from: '2026-05-20T00:00:00Z',
      to: '2026-05-20T23:59:59Z',
    });
    const titles = tasks.map(t => t.title);
    expect(titles).toContain('Task B - May 20');
    expect(titles).not.toContain('Task A - May 19');
    expect(titles).not.toContain('Task C - May 21');
    expect(titles).not.toContain('Task D - no date');
    expect(tasks.length).toBe(1);
  });

  it('returns empty array when no tasks fall in range', async () => {
    const repo = await buildRepo();
    const tasks = await repo.listTasks({
      from: '2026-06-01T00:00:00Z',
      to: '2026-06-30T23:59:59Z',
    });
    // Only tasks in June — seeded tasks have no startDate so they're excluded too
    const withDate = tasks.filter(t => t.startDate !== null);
    expect(withDate.length).toBe(0);
  });

  it('excludes tasks with null startDate when date filter is active', async () => {
    const repo = await buildRepo();
    const tasks = await repo.listTasks({ from: '2026-05-01T00:00:00Z' });
    const nullDateTask = tasks.find(t => t.title === 'Task D - no date');
    expect(nullDateTask).toBeUndefined();
  });
});

describe('ListTasks use case — date range filter passthrough', () => {
  it('passes from/to filter to repository', async () => {
    const repo = await buildRepo();
    const uc = new ListTasks(repo);
    const result = await uc.execute({
      from: '2026-05-20T00:00:00Z',
      to: '2026-05-20T23:59:59Z',
    });
    expect(result.length).toBe(1);
    expect(result[0].title).toBe('Task B - May 20');
  });

  it('returns all tasks when no filter is provided (no date regression)', async () => {
    const repo = await buildRepo();
    const uc = new ListTasks(repo);
    const result = await uc.execute();
    expect(result.length).toBe(11);
  });
});
