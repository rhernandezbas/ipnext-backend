/**
 * TDD — Feature B: filter tasks by customerId
 * GET /api/scheduling?customerId=X returns only tasks of that customer.
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
  async findById(id: string) { return { id, isNetworkProject: false }; }
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

const STAGE_1 = '10000000-0000-4000-a000-000000000001';
const CUSTOMER_A = 'customer-aaaa-0000-0000-000000000001';
const CUSTOMER_B = 'customer-bbbb-0000-0000-000000000002';

const BASE_TASK = {
  description: null,
  priority: 'normal',
  estimatedHours: 1,
  address: null,
  coordinates: null,
  category: 'repair',
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
  watcherIds: [],
  travelTimeTo: null,
  travelTimeFrom: null,
};

async function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const repo = new InMemorySchedulingRepository();
  const stageRepo = new InMemoryStageRepository();
  const createTask = new CreateTask(repo, emptyLookup, emptyLookup, emptyLookup, emptyLookup, emptyLookup);

  // Task for CUSTOMER_A
  await createTask.execute({ ...BASE_TASK, title: 'Task for Customer A (1)', stageId: STAGE_1, customerId: CUSTOMER_A });
  await createTask.execute({ ...BASE_TASK, title: 'Task for Customer A (2)', stageId: STAGE_1, customerId: CUSTOMER_A });
  // Task for CUSTOMER_B
  await createTask.execute({ ...BASE_TASK, title: 'Task for Customer B', stageId: STAGE_1, customerId: CUSTOMER_B });
  // Task with no customer
  await createTask.execute({ ...BASE_TASK, title: 'Task no customer', stageId: STAGE_1 });

  const listTasks = new ListTasks(repo);
  const getTask = new GetTask(repo);
  const updateTask = new UpdateTask(repo, emptyLookup, emptyLookup, emptyLookup, emptyLookup, emptyLookup);
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

function withAuth(req: request.Test) {
  return req.set('Cookie', 'auth_token=fake');
}

describe('GET /api/scheduling — customerId filter (Feature B)', () => {
  let app: express.Express;

  beforeAll(async () => {
    app = await buildApp();
  });

  it('returns only tasks of the given customerId', async () => {
    const res = await withAuth(request(app).get(`/api/scheduling?customerId=${CUSTOMER_A}`));
    expect(res.status).toBe(200);
    const tasks = res.body as Array<{ customerId: string | null; title: string }>;
    expect(tasks.every(t => t.customerId === CUSTOMER_A)).toBe(true);
    expect(tasks.length).toBe(2);
  });

  it('returns only the single task for CUSTOMER_B', async () => {
    const res = await withAuth(request(app).get(`/api/scheduling?customerId=${CUSTOMER_B}`));
    expect(res.status).toBe(200);
    const tasks = res.body as Array<{ customerId: string | null }>;
    expect(tasks.every(t => t.customerId === CUSTOMER_B)).toBe(true);
    expect(tasks.length).toBe(1);
  });

  it('returns all tasks (including seeded) when no customerId filter', async () => {
    const res = await withAuth(request(app).get('/api/scheduling'));
    expect(res.status).toBe(200);
    expect((res.body as unknown[]).length).toBeGreaterThanOrEqual(4);
  });
});
