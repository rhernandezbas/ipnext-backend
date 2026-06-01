/**
 * Unit tests for ListTasks use case + InMemorySchedulingRepository filter predicates.
 * TDD: tests are written before the implementation is complete.
 */
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { ListTasks } from '../../application/use-cases/ListTasks';
import { CreateTask } from '../../application/use-cases/CreateTask';
import { EntityLookup } from '../../domain/ports/EntityLookup';

class StubLookup implements EntityLookup {
  async findById(id: string) { return { id }; }
}
const emptyLookup = new StubLookup();

const STAGE_S1 = 's1-filter-test-0000-000000000001';
const STAGE_S2 = 's2-filter-test-0000-000000000002';
const PROJECT_P1 = 'p1-filter-test-0000-000000000001';
const PROJECT_P2 = 'p2-filter-test-0000-000000000002';
const PARTNER_P = 'partner-filter-000-000000000001';
const ASSIGNEE_A = 'assignee-filter-000-000000000001';

const BASE = {
  description: null as null,
  assignedTo: null as null,
  assignedToId: null as null,
  clientId: null as null,
  clientName: null as null,
  scheduledDate: null as null,
  scheduledTime: null as null,
  priority: 'normal' as const,
  estimatedHours: 1,
  address: null as null,
  coordinates: null as null,
  category: 'repair' as const,
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

  // task 1: s1, p1, partner, assignee, title contains "repair"
  await createTask.execute({ ...BASE, title: 'Repair job alpha', stageId: STAGE_S1, projectId: PROJECT_P1, partnerId: PARTNER_P, assigneeId: ASSIGNEE_A });
  // task 2: s1, p1, no partner
  await createTask.execute({ ...BASE, title: 'Installation beta', stageId: STAGE_S1, projectId: PROJECT_P1 });
  // task 3: s2, p2
  await createTask.execute({ ...BASE, title: 'Inspection gamma', stageId: STAGE_S2, projectId: PROJECT_P2 });

  return repo;
}

describe('InMemorySchedulingRepository.listTasks — filter predicates', () => {
  it('returns all tasks when no filter is provided', async () => {
    const repo = await buildRepo();
    const tasks = await repo.listTasks();
    // 7 seeded + 3 added
    expect(tasks.length).toBe(10);
  });

  it('returns all tasks when empty filter object is passed', async () => {
    const repo = await buildRepo();
    const tasks = await repo.listTasks({});
    expect(tasks.length).toBe(10);
  });

  it('filters by stageIds — returns only matching stage', async () => {
    const repo = await buildRepo();
    const tasks = await repo.listTasks({ stageIds: [STAGE_S1] });
    expect(tasks.every(t => t.stageId === STAGE_S1)).toBe(true);
    expect(tasks.length).toBe(2);
  });

  it('filters by stageIds — returns tasks from either of two stages', async () => {
    const repo = await buildRepo();
    const tasks = await repo.listTasks({ stageIds: [STAGE_S1, STAGE_S2] });
    expect(tasks.length).toBe(3);
  });

  it('filters by projectId', async () => {
    const repo = await buildRepo();
    const tasks = await repo.listTasks({ projectId: PROJECT_P1 });
    expect(tasks.every(t => t.projectId === PROJECT_P1)).toBe(true);
    expect(tasks.length).toBe(2);
  });

  it('filters by partnerId', async () => {
    const repo = await buildRepo();
    const tasks = await repo.listTasks({ partnerId: PARTNER_P });
    expect(tasks.every(t => t.partnerId === PARTNER_P)).toBe(true);
    expect(tasks.length).toBe(1);
  });

  it('filters by assigneeId', async () => {
    const repo = await buildRepo();
    const tasks = await repo.listTasks({ assigneeId: ASSIGNEE_A });
    expect(tasks.every(t => t.assigneeId === ASSIGNEE_A)).toBe(true);
    expect(tasks.length).toBe(1);
  });

  it('filters by q — case-insensitive title search', async () => {
    const repo = await buildRepo();
    const tasks = await repo.listTasks({ q: 'REPAIR' });
    expect(tasks.every(t => t.title.toLowerCase().includes('repair'))).toBe(true);
    expect(tasks.length).toBe(1);
  });

  it('combines projectId AND stageIds (AND logic)', async () => {
    const repo = await buildRepo();
    const tasks = await repo.listTasks({ projectId: PROJECT_P1, stageIds: [STAGE_S1] });
    expect(tasks.every(t => t.projectId === PROJECT_P1 && t.stageId === STAGE_S1)).toBe(true);
    expect(tasks.length).toBe(2);
  });
});

describe('ListTasks use case — filter passthrough', () => {
  it('returns filtered subset when filter is passed', async () => {
    const repo = await buildRepo();
    const uc = new ListTasks(repo);
    const result = await uc.execute({ stageIds: [STAGE_S1] });
    expect(result.every(t => t.stageId === STAGE_S1)).toBe(true);
    expect(result.length).toBe(2);
  });

  it('returns all tasks when no filter is passed (backward compat)', async () => {
    const repo = await buildRepo();
    const uc = new ListTasks(repo);
    const result = await uc.execute();
    expect(result.length).toBe(10);
  });
});
