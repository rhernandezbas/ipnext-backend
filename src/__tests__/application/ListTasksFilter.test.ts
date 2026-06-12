/**
 * Unit tests for ListTasks use case + InMemorySchedulingRepository filter predicates.
 * TDD: tests are written before the implementation is complete.
 */
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { ListTasks } from '../../application/use-cases/ListTasks';
import { CreateTask } from '../../application/use-cases/CreateTask';
import { EntityLookup } from '../../domain/ports/EntityLookup';

class StubLookup implements EntityLookup {
  async findById(id: string) { return { id, isNetworkProject: false }; }
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

describe('InMemorySchedulingRepository.listTasks — search (q) across multiple fields', () => {
  it('matches by address, not just title (case-insensitive)', async () => {
    // Seeded task 1 lives at 'Av. Corrientes 1234, CABA' but its title says nothing
    // about Corrientes. Before the fix, q only hit title → zero results.
    const repo = await buildRepo();
    const tasks = await repo.listTasks({ q: 'corrientes' });
    expect(tasks.some(t => (t.address ?? '').toLowerCase().includes('corrientes'))).toBe(true);
    expect(tasks.length).toBeGreaterThanOrEqual(1);
  });

  it('matches by customer name when the title does NOT contain it', async () => {
    // The real bug: "buscar por un nombre" = the customer's name, which lives on
    // the JOIN, never in the task title.
    const repo = new InMemorySchedulingRepository();
    repo.seedCustomerName('cust-perez', 'Juan Pérez');
    const createTask = new CreateTask(repo, emptyLookup, emptyLookup, emptyLookup, emptyLookup, emptyLookup);
    await createTask.execute({ ...BASE, title: 'Instalación residencial', stageId: STAGE_S1, customerId: 'cust-perez' });

    const tasks = await repo.listTasks({ q: 'pérez' });
    expect(tasks.some(t => (t.customerName ?? '').toLowerCase().includes('pérez'))).toBe(true);
    expect(tasks.length).toBe(1);
  });

  it('matches by exact sequenceNumber digits', async () => {
    const repo = await buildRepo();
    const createTask = new CreateTask(repo, emptyLookup, emptyLookup, emptyLookup, emptyLookup, emptyLookup);
    const created = await createTask.execute({ ...BASE, title: 'tarea-seq-distinta', stageId: STAGE_S1 });

    const tasks = await repo.listTasks({ q: String(created.sequenceNumber) });
    expect(tasks.some(t => t.id === created.id)).toBe(true);
  });

  it('sequenceNumber match is EXACT, not substring (pins Prisma prod semantics)', async () => {
    // RED against the pre-fix InMemory, which used String(seq).includes(q): a
    // partial numeric term that is a substring of a real sequenceNumber would
    // wrongly match. Prisma uses an exact equality clause in prod, so a partial
    // term must yield ZERO results. This pins the in-memory seam to that truth.
    const repo = new InMemorySchedulingRepository();
    const createTask = new CreateTask(repo, emptyLookup, emptyLookup, emptyLookup, emptyLookup, emptyLookup);
    // Title/customer/address carry no digits so the only possible hit is the
    // sequenceNumber arm — isolating the exact-vs-substring decision.
    // sequenceNumber is monotonic & process-global; create until ours has >= 3
    // digits so a 2-char prefix (>= 10) exists that cannot collide with the
    // seeded 1..7 range — guaranteeing a strict, non-colliding substring.
    let created = await createTask.execute({ ...BASE, title: 'alpha bravo charlie', stageId: STAGE_S1 });
    while (String(created.sequenceNumber).length < 3) {
      created = await createTask.execute({ ...BASE, title: 'alpha bravo charlie', stageId: STAGE_S1 });
    }

    const seq = String(created.sequenceNumber);
    const all = await repo.listTasks();
    const fullSeqs = new Set(all.map(t => String(t.sequenceNumber)));
    // Pick a STRICT substring of `seq` (shorter than seq) that is NOT the full
    // sequenceNumber of ANY task — so the only way it could match `created` is
    // the buggy substring semantics, never a legitimate exact hit elsewhere.
    // We scan all substrings (longest first) to dodge collisions with the
    // monotonic counter's other values.
    let partial = '';
    for (let len = seq.length - 1; len >= 1 && !partial; len--) {
      for (let start = 0; start + len <= seq.length && !partial; start++) {
        const cand = seq.slice(start, start + len);
        if (!fullSeqs.has(cand)) partial = cand;
      }
    }
    // Precondition: we found a non-colliding strict substring of `seq`.
    expect(partial).not.toBe('');
    expect(partial.length).toBeLessThan(seq.length);
    expect(seq.includes(partial)).toBe(true);
    expect(fullSeqs.has(partial)).toBe(false);

    // OLD substring InMemory: String(seq).includes(partial) is true → match → RED.
    // NEW exact InMemory: seq === Number(partial) is false → 0 results → GREEN.
    const tasks = await repo.listTasks({ q: partial });
    expect(tasks.length).toBe(0);
  });

  it('search is AND-combined with other filters (project scope respected)', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedCustomerName('cust-z', 'Zulema Ramos');
    const createTask = new CreateTask(repo, emptyLookup, emptyLookup, emptyLookup, emptyLookup, emptyLookup);
    await createTask.execute({ ...BASE, title: 'A', stageId: STAGE_S1, projectId: PROJECT_P1, customerId: 'cust-z' });
    await createTask.execute({ ...BASE, title: 'B', stageId: STAGE_S1, projectId: PROJECT_P2, customerId: 'cust-z' });

    const tasks = await repo.listTasks({ q: 'zulema', projectId: PROJECT_P1 });
    expect(tasks.length).toBe(1);
    expect(tasks[0].projectId).toBe(PROJECT_P1);
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
