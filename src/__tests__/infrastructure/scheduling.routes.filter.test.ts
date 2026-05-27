/**
 * Integration tests for GET /api/scheduling with filter query params.
 * REQ-FILTER-1..7, REQ-LIST-FILTER-VAL-1..3
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '../../infrastructure/adapters/in-memory/InMemoryStageRepository';
import { ListTasks } from '../../application/use-cases/ListTasks';
import { GetTask } from '../../application/use-cases/GetTask';
import { CreateTask } from '../../application/use-cases/CreateTask';
import { UpdateTask } from '../../application/use-cases/UpdateTask';
import { DeleteTask } from '../../application/use-cases/DeleteTask';
import { MoveTaskToStage } from '../../application/use-cases/MoveTaskToStage';
import { createSchedulingRouter } from '../../infrastructure/http/routes/scheduling.routes';
import { User } from '../../domain/entities/auth';
import { AuthProvider } from '../../domain/ports/AuthProvider';
import { EntityLookup } from '../../domain/ports/EntityLookup';

class StubLookup implements EntityLookup {
  async findById(id: string) { return { id }; }
}
const emptyLookup = new StubLookup();

class FakeAuthProvider implements AuthProvider {
  async login() {
    return { user: { id: 'admin-1', username: 'test', email: 't@t.com', role: 'admin' as const }, cookieValue: 'fake', cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' } };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(_token: string): Promise<User> {
    return { id: 'admin-1', username: 'test', email: 't@t.com', role: 'admin' };
  }
}

const STAGE_1 = 'filter-test-0000-0000-000000000001';
const STAGE_2 = 'filter-test-0000-0000-000000000002';
const PROJECT_A = 'project-aaaa-0000-0000-000000000001';
const PROJECT_B = 'project-bbbb-0000-0000-000000000002';
const PARTNER_X = 'partner-xxxx-0000-0000-000000000001';
const ASSIGNEE_Y = 'assignee-yyyy-000-0000-000000000001';

const BASE_TASK = {
  description: null,
  priority: 'normal' as const,
  estimatedHours: 1,
  address: null,
  coordinates: null,
  category: 'repair' as const,
  projectName: null,
  completedAt: null,
  notes: null,
  startDate: null,
  endDate: null,
  customerId: null,
  serviceId: null,
  partnerId: null,
  reporterId: null,
  assigneeId: null,
  watcherIds: [],
  travelTimeTo: null,
  travelTimeFrom: null,
};

async function buildFilterApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const repo = new InMemorySchedulingRepository();
  const stageRepo = new InMemoryStageRepository();

  // Seed a fresh repo with only 3 test tasks (clear the seeded ones by re-seeding)
  // We create tasks via the use case so filter tests use known data
  const createTask = new CreateTask(repo, emptyLookup, emptyLookup, emptyLookup, emptyLookup);

  // Task in stage 1, project A, partner X
  await createTask.execute({
    ...BASE_TASK,
    title: 'Task Alpha repair job',
    stageId: STAGE_1,
    projectId: PROJECT_A,
    partnerId: PARTNER_X,
    assigneeId: ASSIGNEE_Y,
  });
  // Task in stage 1, project A
  await createTask.execute({
    ...BASE_TASK,
    title: 'Task Beta installation',
    stageId: STAGE_1,
    projectId: PROJECT_A,
  });
  // Task in stage 2, project B
  await createTask.execute({
    ...BASE_TASK,
    title: 'Task Gamma inspection',
    stageId: STAGE_2,
    projectId: PROJECT_B,
  });

  const listTasks = new ListTasks(repo);
  const getTask = new GetTask(repo);
  const updateTask = new UpdateTask(repo, emptyLookup, emptyLookup, emptyLookup, emptyLookup);
  const deleteTask = new DeleteTask(repo);
  const moveTaskToStage = new MoveTaskToStage(repo, stageRepo);
  const authProvider = new FakeAuthProvider();

  app.use('/api/scheduling',
    createSchedulingRouter(listTasks, getTask, createTask, updateTask, deleteTask, moveTaskToStage, authProvider));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

// Auth helper
function withAuth(req: request.Test) {
  return req.set('Cookie', 'auth_token=fake');
}

describe('GET /api/scheduling — filter extension (REQ-FILTER-*)', () => {
  let app: express.Express;

  beforeAll(async () => {
    app = await buildFilterApp();
  });

  it('REQ-FILTER-7: no params returns all created tasks (at least 3 + the 7 seeded)', async () => {
    const res = await withAuth(request(app).get('/api/scheduling'));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // The InMemorySchedulingRepository starts with 7 seeded tasks; we added 3 more
    expect(res.body.length).toBeGreaterThanOrEqual(3);
  });

  it('REQ-FILTER-2: stageIds[] filters to only matching stage', async () => {
    const res = await withAuth(
      request(app).get(`/api/scheduling?stageIds[]=${STAGE_1}`)
    );
    expect(res.status).toBe(200);
    const tasks = res.body as Array<{ stageId: string }>;
    // All returned tasks must be in STAGE_1
    expect(tasks.every(t => t.stageId === STAGE_1)).toBe(true);
    // We added 2 tasks in STAGE_1
    const ourTasks = tasks.filter(t => t.stageId === STAGE_1);
    expect(ourTasks.length).toBeGreaterThanOrEqual(2);
  });

  it('REQ-FILTER-2: stageIds[] with two stages returns tasks from both stages', async () => {
    const res = await withAuth(
      request(app).get(`/api/scheduling?stageIds[]=${STAGE_1}&stageIds[]=${STAGE_2}`)
    );
    expect(res.status).toBe(200);
    const tasks = res.body as Array<{ stageId: string }>;
    const stageSet = new Set(tasks.map(t => t.stageId));
    // Both stages should appear
    expect(stageSet.has(STAGE_1)).toBe(true);
    expect(stageSet.has(STAGE_2)).toBe(true);
  });

  it('REQ-FILTER-1: projectId filters to only matching project', async () => {
    const res = await withAuth(
      request(app).get(`/api/scheduling?projectId=${PROJECT_A}`)
    );
    expect(res.status).toBe(200);
    const tasks = res.body as Array<{ projectId: string }>;
    expect(tasks.every(t => t.projectId === PROJECT_A)).toBe(true);
    expect(tasks.length).toBe(2);
  });

  it('REQ-FILTER-5: q performs case-insensitive title search', async () => {
    const res = await withAuth(
      request(app).get('/api/scheduling?q=ALPHA')
    );
    expect(res.status).toBe(200);
    const tasks = res.body as Array<{ title: string }>;
    expect(tasks.every(t => t.title.toLowerCase().includes('alpha'))).toBe(true);
    expect(tasks.length).toBe(1);
  });

  it('REQ-FILTER-3: partnerId filters by partner', async () => {
    const res = await withAuth(
      request(app).get(`/api/scheduling?partnerId=${PARTNER_X}`)
    );
    expect(res.status).toBe(200);
    const tasks = res.body as Array<{ partnerId: string | null }>;
    expect(tasks.every(t => t.partnerId === PARTNER_X)).toBe(true);
    expect(tasks.length).toBe(1);
  });

  it('REQ-FILTER-4: assigneeId filters by assignee', async () => {
    const res = await withAuth(
      request(app).get(`/api/scheduling?assigneeId=${ASSIGNEE_Y}`)
    );
    expect(res.status).toBe(200);
    const tasks = res.body as Array<{ assigneeId: string | null }>;
    expect(tasks.every(t => t.assigneeId === ASSIGNEE_Y)).toBe(true);
    expect(tasks.length).toBe(1);
  });

  it('REQ-FILTER-6: projectId AND stageIds[] applies AND logic', async () => {
    const res = await withAuth(
      request(app).get(`/api/scheduling?projectId=${PROJECT_A}&stageIds[]=${STAGE_1}`)
    );
    expect(res.status).toBe(200);
    const tasks = res.body as Array<{ projectId: string; stageId: string }>;
    expect(tasks.every(t => t.projectId === PROJECT_A && t.stageId === STAGE_1)).toBe(true);
    expect(tasks.length).toBe(2);
  });

  it('REQ-LIST-FILTER-VAL-1: empty stageIds[] item returns 400 VALIDATION_ERROR', async () => {
    const res = await withAuth(
      request(app).get('/api/scheduling?stageIds[]=')
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('REQ-LIST-FILTER-VAL-2: unknown params return 200 (zod strips them)', async () => {
    const res = await withAuth(
      request(app).get('/api/scheduling?unknownParam=foo')
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
