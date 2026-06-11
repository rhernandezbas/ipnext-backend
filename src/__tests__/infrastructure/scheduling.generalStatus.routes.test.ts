/**
 * TDD — #41 HTTP integration for general status.
 *
 * POST /api/scheduling/:id/status → 200/400/401/403/404/422 (REQ-GS-ENDPOINT-1).
 * GET /api/scheduling?status= → individual filters, all, omit≡all, status>isClosed,
 * status+kind combined (REQ-GS-FILTER-1).
 */
import request from 'supertest';
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import cookieParser from 'cookie-parser';

import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '../../infrastructure/adapters/in-memory/InMemoryStageRepository';
import { ListTasks } from '../../application/use-cases/ListTasks';
import { GetTask } from '../../application/use-cases/GetTask';
import { CreateTask } from '../../application/use-cases/CreateTask';
import { UpdateTask } from '../../application/use-cases/UpdateTask';
import { DeleteTask } from '../../application/use-cases/DeleteTask';
import { MoveTaskToStage } from '../../application/use-cases/MoveTaskToStage';
import { SetTaskGeneralStatus } from '../../application/use-cases/SetTaskGeneralStatus';
import { createSchedulingRouter } from '../../infrastructure/http/routes/scheduling.routes';
import { User } from '../../domain/entities/auth';
import { AuthProvider } from '../../domain/ports/AuthProvider';
import { Stage } from '../../domain/entities/workflow';
import { EntityLookup } from '../../domain/ports/EntityLookup';

const DEFAULT_STAGE_ID_PENDING = '10000000-0000-4000-a000-000000000001';

class StubLookup implements EntityLookup {
  async findById(_id: string) { return null; }
}

class FakeAuthProvider implements AuthProvider {
  async login() {
    return { user: { id: 'admin-1', username: 'testuser', email: 't@t.com', role: 'admin' as const }, cookieValue: 'fake', cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' } };
  }
  logout() { return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } }; }
  async getSession(_token: string): Promise<User> {
    return { id: 'admin-1', username: 'testuser', email: 't@t.com', role: 'admin' };
  }
}

const denyWrite: RequestHandler = (_req, res, _next) => {
  res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
};

const CREATE_INPUT = {
  title: 'Tarea', description: null, stageId: DEFAULT_STAGE_ID_PENDING, priority: 'normal',
  estimatedHours: 1, address: null, coordinates: null, category: 'other', completedAt: null,
  notes: null, startDate: null, endDate: null, customerId: null, contractId: null,
  partnerId: null, reporterId: null, assigneeId: null, travelTimeTo: null, travelTimeFrom: null,
};

function makeStages(stageRepo: InMemoryStageRepository): void {
  const stages: Stage[] = [
    { id: DEFAULT_STAGE_ID_PENDING, workflowId: 'wf-default', name: 'Nuevo', code: 'nuevo', category: 'nuevo', order: 0, color: null },
  ];
  stages.forEach(s => stageRepo.addDirect(s));
}

function buildApp(opts: { schedWrite?: RequestHandler } = {}) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const repo = new InMemorySchedulingRepository();
  const stageRepo = new InMemoryStageRepository();
  makeStages(stageRepo);
  const authProvider = new FakeAuthProvider();
  const emptyLookup = new StubLookup();

  const router = createSchedulingRouter(
    new ListTasks(repo),
    new GetTask(repo),
    new CreateTask(repo, emptyLookup, emptyLookup, emptyLookup, emptyLookup, emptyLookup),
    new UpdateTask(repo, emptyLookup, emptyLookup, emptyLookup, emptyLookup, emptyLookup),
    new DeleteTask(repo),
    new MoveTaskToStage(repo, stageRepo),
    authProvider,
    undefined, // stageRepo
    undefined, // checklist
    undefined, // setTaskInventoryReview
    undefined, // bulkMoveTasksToStage
    undefined, // resendDeps
    undefined, // getTaskActivity
    undefined, // requireInventoryWrite
    undefined, // retireContractEquipment
    new SetTaskGeneralStatus(repo),
    opts.schedWrite, // requireSchedulingWrite (undefined = pass-through)
  );
  app.use('/api/scheduling', router);
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    res.status(500).json({ error: 'Internal server error' });
  });
  return { app, repo };
}

const cookie = 'auth_token=fake';

describe('POST /api/scheduling/:id/status (#41)', () => {
  it('closes a task → 200 with generalStatus=closed, isClosed=true', async () => {
    const { app, repo } = buildApp();
    const created = await repo.createTask(CREATE_INPUT);
    const res = await request(app).post(`/api/scheduling/${created.id}/status`).set('Cookie', cookie).send({ status: 'closed' });
    expect(res.status).toBe(200);
    expect(res.body.generalStatus).toBe('closed');
    expect(res.body.isClosed).toBe(true);
  });

  it('dismisses a task → 200 generalStatus=dismissed, isClosed=false', async () => {
    const { app, repo } = buildApp();
    const created = await repo.createTask(CREATE_INPUT);
    const res = await request(app).post(`/api/scheduling/${created.id}/status`).set('Cookie', cookie).send({ status: 'dismissed' });
    expect(res.status).toBe(200);
    expect(res.body.generalStatus).toBe('dismissed');
    expect(res.body.isClosed).toBe(false);
  });

  it('invalid status value → 400 VALIDATION_ERROR', async () => {
    const { app, repo } = buildApp();
    const created = await repo.createTask(CREATE_INPUT);
    const res = await request(app).post(`/api/scheduling/${created.id}/status`).set('Cookie', cookie).send({ status: 'archived' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('missing status field → 400 VALIDATION_ERROR', async () => {
    const { app, repo } = buildApp();
    const created = await repo.createTask(CREATE_INPUT);
    const res = await request(app).post(`/api/scheduling/${created.id}/status`).set('Cookie', cookie).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('unauthenticated → 401 UNAUTHORIZED', async () => {
    const { app, repo } = buildApp();
    const created = await repo.createTask(CREATE_INPUT);
    const res = await request(app).post(`/api/scheduling/${created.id}/status`).send({ status: 'closed' });
    expect(res.status).toBe(401);
  });

  it('no scheduling.write → 403 FORBIDDEN', async () => {
    const { app, repo } = buildApp({ schedWrite: denyWrite });
    const created = await repo.createTask(CREATE_INPUT);
    const res = await request(app).post(`/api/scheduling/${created.id}/status`).set('Cookie', cookie).send({ status: 'closed' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('task not found → 404 TASK_NOT_FOUND', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/scheduling/x-99/status').set('Cookie', cookie).send({ status: 'closed' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TASK_NOT_FOUND');
  });
});

describe('GET /api/scheduling?status= (#41)', () => {
  async function seedAll(repo: InMemorySchedulingRepository) {
    const open = await repo.createTask({ ...CREATE_INPUT, title: 'open-task' });
    const closed = await repo.createTask({ ...CREATE_INPUT, title: 'closed-task' });
    await repo.updateTask(closed.id, { generalStatus: 'closed' });
    const dismissed = await repo.createTask({ ...CREATE_INPUT, title: 'dismissed-task' });
    await repo.updateTask(dismissed.id, { generalStatus: 'dismissed' });
    return { open, closed, dismissed };
  }

  it('status=open returns only open tasks', async () => {
    const { app, repo } = buildApp();
    const { open, closed, dismissed } = await seedAll(repo);
    const res = await request(app).get('/api/scheduling?status=open').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const ids = (res.body as { id: string }[]).map(t => t.id);
    expect(ids).toContain(open.id);
    expect(ids).not.toContain(closed.id);
    expect(ids).not.toContain(dismissed.id);
  });

  it('status=closed returns only closed tasks', async () => {
    const { app, repo } = buildApp();
    const { open, closed } = await seedAll(repo);
    const res = await request(app).get('/api/scheduling?status=closed').set('Cookie', cookie);
    const ids = (res.body as { id: string }[]).map(t => t.id);
    expect(ids).toContain(closed.id);
    expect(ids).not.toContain(open.id);
  });

  it('status=dismissed returns only dismissed tasks', async () => {
    const { app, repo } = buildApp();
    const { dismissed, open } = await seedAll(repo);
    const res = await request(app).get('/api/scheduling?status=dismissed').set('Cookie', cookie);
    const ids = (res.body as { id: string }[]).map(t => t.id);
    expect(ids).toContain(dismissed.id);
    expect(ids).not.toContain(open.id);
  });

  it('status=all returns all three', async () => {
    const { app, repo } = buildApp();
    const { open, closed, dismissed } = await seedAll(repo);
    const res = await request(app).get('/api/scheduling?status=all').set('Cookie', cookie);
    const ids = (res.body as { id: string }[]).map(t => t.id);
    expect(ids).toEqual(expect.arrayContaining([open.id, closed.id, dismissed.id]));
  });

  it('omitted status ≡ all (back-compat)', async () => {
    const { app, repo } = buildApp();
    const { open, closed, dismissed } = await seedAll(repo);
    const res = await request(app).get('/api/scheduling').set('Cookie', cookie);
    const ids = (res.body as { id: string }[]).map(t => t.id);
    expect(ids).toEqual(expect.arrayContaining([open.id, closed.id, dismissed.id]));
  });

  it('invalid status value → 400 VALIDATION_ERROR', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/scheduling?status=archived').set('Cookie', cookie);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('status wins over isClosed when both present', async () => {
    const { app, repo } = buildApp();
    const { open, closed } = await seedAll(repo);
    // isClosed=true would return only closed; status=open overrides → only open.
    const res = await request(app).get('/api/scheduling?isClosed=true&status=open').set('Cookie', cookie);
    const ids = (res.body as { id: string }[]).map(t => t.id);
    expect(ids).toContain(open.id);
    expect(ids).not.toContain(closed.id);
  });

  it('status combines with kind (status=open&kind=network)', async () => {
    const { app, repo } = buildApp();
    await seedAll(repo); // all customer-kind, open/closed/dismissed
    const netOpen = await repo.createTask({ ...CREATE_INPUT, title: 'net-open', kind: 'network', networkSiteId: 'ns-1', customerId: null, contractId: null });
    const res = await request(app).get('/api/scheduling?status=open&kind=network').set('Cookie', cookie);
    const ids = (res.body as { id: string }[]).map(t => t.id);
    expect(ids).toEqual([netOpen.id]);
  });
});
