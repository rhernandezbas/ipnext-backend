/**
 * TDD — #86 HTTP integration: archive endpoint + hard-delete guard.
 *
 * POST /api/scheduling/:id/archive
 *   200  closed task → archived
 *   422  open task → TASK_NOT_CLOSED
 *   404  unknown task
 *
 * DELETE /api/scheduling/:id
 *   403  when requireHardDelete guard denies
 *   200  when guard passes (task deleted → 204)
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
import { ArchiveTask } from '../../application/use-cases/ArchiveTask';
import { createSchedulingRouter } from '../../infrastructure/http/routes/scheduling.routes';
import { User } from '../../domain/entities/auth';
import { AuthProvider } from '../../domain/ports/AuthProvider';
import { EntityLookup } from '../../domain/ports/EntityLookup';
import { Stage } from '../../domain/entities/workflow';

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

const denyHardDelete: RequestHandler = (_req, res, _next) => {
  res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
};

const allowHardDelete: RequestHandler = (_req, _res, next) => next();

function buildApp(opts: {
  requireHardDelete?: RequestHandler;
  archiveTask?: ArchiveTask;
  repo?: InMemorySchedulingRepository;
} = {}) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const repo = opts.repo ?? new InMemorySchedulingRepository();
  const stageRepo = new InMemoryStageRepository();
  const stages: Stage[] = [
    { id: DEFAULT_STAGE_ID_PENDING, workflowId: 'wf-default', name: 'Nuevo', code: 'nuevo', category: 'nuevo', order: 0, color: null },
  ];
  stages.forEach(s => stageRepo.addDirect(s));

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
    undefined, // sessionRepo
    undefined, // stageRepo
    undefined, // checklist
    undefined, // setTaskInventoryReview
    undefined, // bulkMoveTasksToStage
    undefined, // resendDeps
    undefined, // getTaskActivity
    undefined, // requireInventoryWrite
    undefined, // retireContractEquipment
    undefined, // setTaskGeneralStatus
    undefined, // requireSchedulingWrite
    opts.archiveTask,
    opts.requireHardDelete,
  );
  app.use('/api/scheduling', router);
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    res.status(500).json({ error: 'Internal server error' });
  });
  return { app, repo };
}

const cookie = 'auth_token=fake';

describe('POST /api/scheduling/:id/archive (#86)', () => {
  it('200 — archives a closed task', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-closed', stageId: DEFAULT_STAGE_ID_PENDING, generalStatus: 'closed', isClosed: true, archivedAt: null });
    const { app } = buildApp({ repo, archiveTask: new ArchiveTask(repo) });

    const res = await request(app)
      .post('/api/scheduling/task-closed/archive')
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.archivedAt).not.toBeNull();
  });

  it('422 TASK_NOT_CLOSED — open task', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-open', stageId: DEFAULT_STAGE_ID_PENDING, generalStatus: 'open', isClosed: false, archivedAt: null });
    const { app } = buildApp({ repo, archiveTask: new ArchiveTask(repo) });

    const res = await request(app)
      .post('/api/scheduling/task-open/archive')
      .set('Cookie', cookie);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TASK_NOT_CLOSED');
  });

  it('404 — unknown task', async () => {
    const repo = new InMemorySchedulingRepository();
    const { app } = buildApp({ repo, archiveTask: new ArchiveTask(repo) });

    const res = await request(app)
      .post('/api/scheduling/nonexistent/archive')
      .set('Cookie', cookie);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TASK_NOT_FOUND');
  });

  it('404 — route not registered when archiveTask is omitted', async () => {
    const { app } = buildApp({});

    const res = await request(app)
      .post('/api/scheduling/some-task/archive')
      .set('Cookie', cookie);

    // Without archiveTask injected, the route is not registered → 404
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/scheduling/:id (#86 hard_delete guard)', () => {
  it('403 — when requireHardDelete guard denies', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-1', stageId: DEFAULT_STAGE_ID_PENDING });
    const { app } = buildApp({ repo, requireHardDelete: denyHardDelete });

    const res = await request(app)
      .delete('/api/scheduling/task-1')
      .set('Cookie', cookie);

    expect(res.status).toBe(403);
  });

  it('204 — when requireHardDelete guard allows', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-2', stageId: DEFAULT_STAGE_ID_PENDING });
    const { app } = buildApp({ repo, requireHardDelete: allowHardDelete });

    const res = await request(app)
      .delete('/api/scheduling/task-2')
      .set('Cookie', cookie);

    expect(res.status).toBe(204);
  });

  it('204 — when requireHardDelete is omitted (pass-through for back-compat)', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-3', stageId: DEFAULT_STAGE_ID_PENDING });
    const { app } = buildApp({ repo });

    const res = await request(app)
      .delete('/api/scheduling/task-3')
      .set('Cookie', cookie);

    expect(res.status).toBe(204);
  });
});
