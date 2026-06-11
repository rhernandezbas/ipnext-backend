/**
 * TDD — Feature C: contractId accepted and persisted on task create/update.
 * Verifies that contractId flows through route → use-case → repo → response.
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
const CONTRACT_ID  = 'service-1111-0000-0000-000000000001';
const CUSTOMER_ID = 'customer-1111-0000-0000-000000000001';

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const repo = new InMemorySchedulingRepository();
  const stageRepo = new InMemoryStageRepository();
  const createTask = new CreateTask(repo, emptyLookup, emptyLookup, emptyLookup, emptyLookup, emptyLookup);
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

describe('POST /api/scheduling — contractId persistence (Feature C)', () => {
  it('persists contractId and returns it in the response', async () => {
    const app = buildApp();
    const res = await withAuth(request(app).post('/api/scheduling').send({
      title: 'Task with service',
      priority: 'normal',
      estimatedHours: 1,
      category: 'installation',
      stageId: STAGE_1,
      kind: 'customer',
      contractId: CONTRACT_ID,
      customerId: CUSTOMER_ID,
    }));

    expect(res.status).toBe(201);
    expect(res.body.contractId).toBe(CONTRACT_ID);
  });

  it('REQ-REQUIRED-2: creating a task without contractId → 400 VALIDATION_ERROR', async () => {
    // contractId is now required on create — omitting it must be rejected at the DTO layer
    const app = buildApp();
    const res = await withAuth(request(app).post('/api/scheduling').send({
      title: 'Task without service',
      priority: 'normal',
      estimatedHours: 1,
      category: 'installation',
      stageId: STAGE_1,
      customerId: CUSTOMER_ID,
      // contractId intentionally omitted
    }));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('REQ-REQUIRED-1: creating a task without customerId → 400 VALIDATION_ERROR', async () => {
    // customerId is now required on create — omitting it must be rejected at the DTO layer
    const app = buildApp();
    const res = await withAuth(request(app).post('/api/scheduling').send({
      title: 'Task without customer',
      priority: 'normal',
      estimatedHours: 1,
      category: 'installation',
      stageId: STAGE_1,
      contractId: CONTRACT_ID,
      // customerId intentionally omitted
    }));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('PUT /api/scheduling/:id — contractId update persistence (Feature C)', () => {
  it('updates contractId and returns updated value', async () => {
    const app = buildApp();

    // Create task with required fields
    const createRes = await withAuth(request(app).post('/api/scheduling').send({
      title: 'Task to update',
      priority: 'normal',
      estimatedHours: 1,
      category: 'installation',
      stageId: STAGE_1,
      kind: 'customer',
      customerId: CUSTOMER_ID,
      contractId: CONTRACT_ID,
    }));
    expect(createRes.status).toBe(201);
    const taskId = createRes.body.id as string;

    // Update with contractId
    const updateRes = await withAuth(request(app).put(`/api/scheduling/${taskId}`).send({
      contractId: CONTRACT_ID,
    }));

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.contractId).toBe(CONTRACT_ID);
  });
});
