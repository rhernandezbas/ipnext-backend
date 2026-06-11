/**
 * #40 — kind filter on the task list (InMemory parity).
 *
 * REQ-KIND-FILTER-1/2:
 *  - listTasks({ kind: 'network' })  → only network tasks
 *  - listTasks({ kind: 'customer' }) → only customer tasks
 *  - listTasks()                     → all tasks (backward compat)
 */
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';

const TASK_FIELDS = {
  description: null,
  address: null,
  coordinates: null,
  projectId: null,
  projectName: null,
  completedAt: null,
  notes: null,
  startDate: null,
  endDate: null,
  customerId: null,
  contractId: null,
  partnerId: null,
  reporterId: null,
  assigneeId: null,
  watcherIds: [] as string[],
  travelTimeTo: null,
  travelTimeFrom: null,
};

async function seedRepo() {
  const repo = new InMemorySchedulingRepository();
  // Clear default seeded tasks for a deterministic count.
  (repo as unknown as { tasks: unknown[] }).tasks = [];
  await repo.createTask({
    title: 'Customer A', stageId: 's1', priority: 'normal', estimatedHours: 1,
    category: 'installation', kind: 'customer', networkSiteId: null, ...TASK_FIELDS,
  } as never);
  await repo.createTask({
    title: 'Customer B', stageId: 's1', priority: 'normal', estimatedHours: 1,
    category: 'installation', kind: 'customer', networkSiteId: null, ...TASK_FIELDS,
  } as never);
  await repo.createTask({
    title: 'Network A', stageId: 's1', priority: 'normal', estimatedHours: 1,
    category: 'maintenance', kind: 'network', networkSiteId: 'ns-1', ...TASK_FIELDS,
  } as never);
  return repo;
}

describe('InMemorySchedulingRepository.listTasks — kind filter (#40)', () => {
  it('kind=network returns only network tasks', async () => {
    const repo = await seedRepo();
    const tasks = await repo.listTasks({ kind: 'network' });
    expect(tasks.length).toBe(1);
    expect(tasks.every(t => t.kind === 'network')).toBe(true);
  });

  it('kind=customer returns only customer tasks', async () => {
    const repo = await seedRepo();
    const tasks = await repo.listTasks({ kind: 'customer' });
    expect(tasks.length).toBe(2);
    expect(tasks.every(t => t.kind === 'customer')).toBe(true);
  });

  it('no kind filter returns all tasks', async () => {
    const repo = await seedRepo();
    const tasks = await repo.listTasks();
    expect(tasks.length).toBe(3);
  });
});
