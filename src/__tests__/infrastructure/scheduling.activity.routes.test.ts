import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryTaskActivityRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskActivityRepository';
import { ListTasks } from '@application/use-cases/ListTasks';
import { GetTask } from '@application/use-cases/GetTask';
import { CreateTask } from '@application/use-cases/CreateTask';
import { UpdateTask } from '@application/use-cases/UpdateTask';
import { DeleteTask } from '@application/use-cases/DeleteTask';
import { MoveTaskToStage } from '@application/use-cases/MoveTaskToStage';
import { GetTaskActivity } from '@application/use-cases/GetTaskActivity';
import { createSchedulingRouter } from '@infrastructure/http/routes/scheduling.routes';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { EntityLookup } from '@domain/ports/EntityLookup';
import { User } from '@domain/entities/auth';

class AnyLookup implements EntityLookup {
  async findById(id: string) { return { id, isNetworkProject: false }; }
}

class FakeAuth implements AuthProvider {
  async login() {
    return { user: { id: 'admin-1', username: 't', email: 't@t.com', role: 'admin' as const }, cookieValue: 'fake', cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' } };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(_token: string): Promise<User> {
    return { id: 'admin-1', username: 't', email: 't@t.com', role: 'admin' };
  }
}

function buildActivityApp() {
  let clock = Date.parse('2026-06-03T10:00:00Z');
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const repo = new InMemorySchedulingRepository();
  const stageRepo = new InMemoryStageRepository();
  const activityRepo = new InMemoryTaskActivityRepository({ now: () => new Date(clock) });
  const any = new AnyLookup();

  const listTasks = new ListTasks(repo);
  const getTask = new GetTask(repo);
  const createTask = new CreateTask(repo, any, any, any, any, any);
  const updateTask = new UpdateTask(repo, any, any, any, any, any);
  const deleteTask = new DeleteTask(repo);
  const moveTaskToStage = new MoveTaskToStage(repo, stageRepo);
  const getTaskActivity = new GetTaskActivity(repo, activityRepo);

  app.use('/api/scheduling', createSchedulingRouter(
    listTasks, getTask, createTask, updateTask, deleteTask, moveTaskToStage, new FakeAuth(),
    undefined, undefined, undefined, undefined, undefined, undefined, getTaskActivity,
  ));

  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    res.status(500).json({ error: 'Internal server error' });
  });

  return { app, repo, activityRepo, tick: () => { clock += 1000; } };
}

const AUTH = ['Cookie', 'auth_token=fake'] as const;

describe('GET /api/scheduling/:id/activity (B.4)', () => {
  it('401 when unauthenticated', async () => {
    const { app } = buildActivityApp();
    const res = await request(app).get('/api/scheduling/task-1/activity');
    expect(res.status).toBe(401);
  });

  it('404 when the task does not exist', async () => {
    const { app } = buildActivityApp();
    const res = await request(app).get('/api/scheduling/ghost/activity').set(...AUTH);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TASK_NOT_FOUND');
  });

  it('200 with an empty feed for a task with no activity', async () => {
    const h = buildActivityApp();
    h.repo.seedTask({ id: 'task-1' });
    const res = await request(h.app).get('/api/scheduling/task-1/activity').set(...AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  it('200 newest-first and paginates via nextCursor', async () => {
    const h = buildActivityApp();
    h.repo.seedTask({ id: 'task-1' });
    await h.activityRepo.create({ taskId: 'task-1', type: 'created', actorId: 'u', actorName: 'A', metadata: null }); h.tick();
    await h.activityRepo.create({ taskId: 'task-1', type: 'priority_changed', actorId: 'u', actorName: 'A', metadata: null }); h.tick();
    await h.activityRepo.create({ taskId: 'task-1', type: 'commented', actorId: 'u', actorName: 'A', metadata: null });

    const page1 = await request(h.app).get('/api/scheduling/task-1/activity?limit=2').set(...AUTH);
    expect(page1.status).toBe(200);
    expect(page1.body.items.map((a: { type: string }) => a.type)).toEqual(['commented', 'priority_changed']);
    expect(page1.body.nextCursor).toBeTruthy();

    const page2 = await request(h.app)
      .get(`/api/scheduling/task-1/activity?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`)
      .set(...AUTH);
    expect(page2.status).toBe(200);
    expect(page2.body.items.map((a: { type: string }) => a.type)).toEqual(['created']);
    expect(page2.body.nextCursor).toBeNull();
  });

  it('400 on a malformed cursor', async () => {
    const h = buildActivityApp();
    h.repo.seedTask({ id: 'task-1' });
    const res = await request(h.app).get('/api/scheduling/task-1/activity?cursor=garbage').set(...AUTH);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CURSOR');
  });
});
