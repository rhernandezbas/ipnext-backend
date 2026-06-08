import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryTaskActivityRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskActivityRepository';
import { InMemoryTaskCommentRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskCommentRepository';
import { ListTasks } from '@application/use-cases/ListTasks';
import { GetTask } from '@application/use-cases/GetTask';
import { CreateTask } from '@application/use-cases/CreateTask';
import { UpdateTask } from '@application/use-cases/UpdateTask';
import { DeleteTask } from '@application/use-cases/DeleteTask';
import { MoveTaskToStage } from '@application/use-cases/MoveTaskToStage';
import { GetTaskActivity } from '@application/use-cases/GetTaskActivity';
import { ListTaskComments } from '@application/use-cases/ListTaskComments';
import { AddTaskComment } from '@application/use-cases/AddTaskComment';
import { DeleteTaskComment } from '@application/use-cases/DeleteTaskComment';
import { RecordTaskActivity } from '@application/use-cases/RecordTaskActivity';
import { DefaultTaskActivityRecorder } from '@infrastructure/services/DefaultTaskActivityRecorder';
import { createSchedulingRouter } from '@infrastructure/http/routes/scheduling.routes';
import { createTaskCommentsRouter } from '@infrastructure/http/routes/taskComments.routes';
import { createAuthMiddleware } from '@infrastructure/http/middleware/authMiddleware';
import type { TaskActivityRepository } from '@domain/ports/TaskActivityRepository';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { EntityLookup } from '@domain/ports/EntityLookup';
import { User } from '@domain/entities/auth';
import { Stage } from '@domain/entities/workflow';

const PENDING = '10000000-0000-4000-a000-000000000001';
const IN_PROGRESS = '10000000-0000-4000-a000-000000000002';
const CUSTOMER_ID = 'customer-default-0000-000000000001';
const CONTRACT_ID = 'contract-default-00000-000000000001';
const AUTH = ['Cookie', 'auth_token=fake'] as const;

class AnyLookup implements EntityLookup {
  async findById(id: string) { return { id }; }
}
class FakeAuth implements AuthProvider {
  async login() {
    return { user: { id: 'admin-1', username: 'Tester', email: 't@t.com', role: 'admin' as const }, cookieValue: 'fake', cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' } };
  }
  logout() { return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } }; }
  async getSession(_t: string): Promise<User> { return { id: 'admin-1', username: 'Tester', email: 't@t.com', role: 'admin' }; }
}

function stages(stageRepo: InMemoryStageRepository) {
  const list: Stage[] = [
    { id: PENDING, workflowId: 'wf-default', name: 'Nuevo', code: 'nuevo', category: 'nuevo', order: 0, color: null },
    { id: IN_PROGRESS, workflowId: 'wf-default', name: 'En progreso', code: 'en_progreso', category: 'enProgreso', order: 7, color: null },
  ];
  list.forEach(s => stageRepo.addDirect(s));
}

/** Wire a full app sharing one recorder; `activityRepo` lets a throwing repo be injected (E.3). */
function buildApp(activityRepo?: TaskActivityRepository) {
  let clock = Date.parse('2026-06-03T10:00:00Z');
  const repo = new InMemorySchedulingRepository();
  const stageRepo = new InMemoryStageRepository();
  stages(stageRepo);
  const activities = activityRepo ?? new InMemoryTaskActivityRepository({ now: () => new Date((clock += 1000)) });
  const commentRepo = new InMemoryTaskCommentRepository();
  const recorder = new DefaultTaskActivityRecorder(new RecordTaskActivity(activities));
  const any = new AnyLookup();

  const createTask = new CreateTask(repo, any, any, any, any, any, undefined, recorder);
  const updateTask = new UpdateTask(repo, any, any, any, any, any, recorder);
  const moveTaskToStage = new MoveTaskToStage(repo, stageRepo, undefined, recorder);
  const getTaskActivity = new GetTaskActivity(repo, activities instanceof InMemoryTaskActivityRepository ? activities : new InMemoryTaskActivityRepository());
  const addComment = new AddTaskComment(commentRepo, recorder);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  const auth = createAuthMiddleware(new FakeAuth());
  const noop = (_req: Request, _res: Response, next: NextFunction) => next();
  app.use('/api/scheduling', createSchedulingRouter(
    new ListTasks(repo), new GetTask(repo), createTask, updateTask, new DeleteTask(repo), moveTaskToStage, new FakeAuth(),
    undefined, undefined, undefined, undefined, undefined, getTaskActivity,
  ));
  app.use('/api/scheduling', createTaskCommentsRouter(
    new ListTaskComments(commentRepo), addComment, new DeleteTaskComment(commentRepo, recorder), auth,
    { read: noop, write: noop, delete: noop },
  ));
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => { res.status(500).json({ error: 'boom' }); });
  return { app };
}

const CREATE_BODY = {
  title: 'Integration task', description: 'd', priority: 'normal', estimatedHours: 1,
  address: 'X', coordinates: null, category: 'other', completedAt: null, notes: '',
  kind: 'customer' as const,
  customerId: CUSTOMER_ID, contractId: CONTRACT_ID,
};

describe('activity log integration (E.2)', () => {
  it('records the full create→update→move→comment flow and returns 4 events newest-first', async () => {
    const { app } = buildApp();

    const created = await request(app).post('/api/scheduling').set(...AUTH).send(CREATE_BODY);
    expect(created.status).toBe(201);
    const taskId = created.body.id;

    expect((await request(app).put(`/api/scheduling/${taskId}`).set(...AUTH).send({ priority: 'high' })).status).toBe(200);
    expect((await request(app).patch(`/api/scheduling/${taskId}/stage`).set(...AUTH).send({ stageId: IN_PROGRESS })).status).toBe(200);
    expect((await request(app).post(`/api/scheduling/${taskId}/comments`).set(...AUTH).send({ body: 'hola', authorName: 'Tester' })).status).toBe(201);

    const feed = await request(app).get(`/api/scheduling/${taskId}/activity`).set(...AUTH);
    expect(feed.status).toBe(200);
    expect(feed.body.items.map((a: { type: string }) => a.type)).toEqual([
      'commented', 'stage_changed', 'priority_changed', 'created',
    ]);
    // actor snapshot threaded from the authenticated user
    expect(feed.body.items[0].actorName).toBe('Tester');
  });
});

describe('activity log resilience (E.3)', () => {
  it('a recorder whose repo throws on every call does NOT break the originating endpoints', async () => {
    const throwingRepo: TaskActivityRepository = {
      create: async () => { throw new Error('db down'); },
      createMany: async () => { throw new Error('db down'); },
      listByTask: async () => [],
    };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { app } = buildApp(throwingRepo);

    const created = await request(app).post('/api/scheduling').set(...AUTH).send(CREATE_BODY);
    expect(created.status).toBe(201);

    const updated = await request(app).put(`/api/scheduling/${created.body.id}`).set(...AUTH).send({ priority: 'high' });
    expect(updated.status).toBe(200);

    warn.mockRestore();
  });
});
