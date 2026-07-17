/**
 * SECURITY FIX (K3-FE review, CRITICAL) — PUT /api/scheduling/:id only had `auth`,
 * ZERO permission check. onuSerial arms the fiber-auto-provision-watcher, which
 * provisions REAL ONUs with no human in the loop. Any authenticated user could
 * set/clear it via direct API call — the FE gate (scheduling.write) is cosmetic.
 *
 * Surgical fix: do NOT gate the whole PUT (operators edit title/address/assignee
 * daily and that flow never required a permission — gating it all would break
 * live flows). Instead: ONLY when the body carries the `onuSerial` key (present,
 * even null — clearing also arms/disarms) → require `scheduling.write` (the same
 * schedWrite guard already used by POST /:id/status and /:id/archive). No key →
 * behaves EXACTLY as before (pass-through / no permission required).
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
import { createSchedulingRouter } from '../../infrastructure/http/routes/scheduling.routes';
import { User } from '../../domain/entities/auth';
import { AuthProvider } from '../../domain/ports/AuthProvider';
import { EntityLookup } from '../../domain/ports/EntityLookup';
import { ProjectKindLookup } from '../../domain/ports/ProjectKindLookup';
import { Stage } from '../../domain/entities/workflow';

const DEFAULT_STAGE_ID_PENDING = '10000000-0000-4000-a000-000000000001';

// Accepts any non-null ID — FK identity is not under test here.
class AnyLookup implements EntityLookup, ProjectKindLookup {
  async findById(id: string) { return { id, isNetworkProject: false }; }
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

const denySchedWrite: RequestHandler = (_req, res, _next) => {
  res.status(403).json({ error: 'FORBIDDEN', code: 'PERMISSION_DENIED', module: 'scheduling', action: 'write' });
};

const allowSchedWrite: RequestHandler = (_req, _res, next) => next();

function buildApp(opts: {
  requireSchedulingWrite?: RequestHandler;
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
  const anyLookup = new AnyLookup();

  const router = createSchedulingRouter(
    new ListTasks(repo),
    new GetTask(repo),
    new CreateTask(repo, anyLookup, anyLookup, anyLookup, anyLookup, anyLookup),
    new UpdateTask(repo, anyLookup, anyLookup, anyLookup, anyLookup, anyLookup),
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
    undefined, // setTaskGeneralStatus
    opts.requireSchedulingWrite, // requireSchedulingWrite
    undefined, // archiveTask
    undefined, // requireHardDelete
  );
  app.use('/api/scheduling', router);
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    res.status(500).json({ error: 'Internal server error' });
  });
  return { app, repo };
}

const cookie = 'auth_token=fake';

describe('PUT /api/scheduling/:id — onuSerial permission gate (security fix K3-FE review)', () => {
  it('403 PERMISSION_DENIED — onuSerial in body + user WITHOUT scheduling.write, task NOT changed', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-1', stageId: DEFAULT_STAGE_ID_PENDING, title: 'Original', onuSerial: null });
    const { app } = buildApp({ repo, requireSchedulingWrite: denySchedWrite });

    const res = await request(app)
      .put('/api/scheduling/task-1')
      .set('Cookie', cookie)
      .send({ onuSerial: 'HWTC11112222' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');

    const after = await repo.getTask('task-1');
    expect(after!.onuSerial).toBeNull();
    expect(after!.title).toBe('Original');
  });

  it('403 PERMISSION_DENIED — onuSerial: null (clearing) + user WITHOUT scheduling.write, serial NOT cleared', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-2', stageId: DEFAULT_STAGE_ID_PENDING, onuSerial: 'HWTC11112222' });
    const { app } = buildApp({ repo, requireSchedulingWrite: denySchedWrite });

    const res = await request(app)
      .put('/api/scheduling/task-2')
      .set('Cookie', cookie)
      .send({ onuSerial: null });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');

    const after = await repo.getTask('task-2');
    expect(after!.onuSerial).toBe('HWTC11112222');
  });

  it('200 — onuSerial in body + user WITH scheduling.write → saved normalized', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-3', stageId: DEFAULT_STAGE_ID_PENDING, onuSerial: null });
    const { app } = buildApp({ repo, requireSchedulingWrite: allowSchedWrite });

    const res = await request(app)
      .put('/api/scheduling/task-3')
      .set('Cookie', cookie)
      .send({ onuSerial: ' hwtc 1111 2222 ' });

    expect(res.status).toBe(200);
    expect(res.body.onuSerial).toBe('HWTC11112222');

    const after = await repo.getTask('task-3');
    expect(after!.onuSerial).toBe('HWTC11112222');
  });

  it('200 — PUT WITHOUT onuSerial key + user WITHOUT scheduling.write → unchanged behaviour (no regression)', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-4', stageId: DEFAULT_STAGE_ID_PENDING, title: 'Before', address: 'Old address', onuSerial: 'HWTC11112222' });
    const { app } = buildApp({ repo, requireSchedulingWrite: denySchedWrite });

    const res = await request(app)
      .put('/api/scheduling/task-4')
      .set('Cookie', cookie)
      .send({ title: 'After', address: 'New address' });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('After');
    expect(res.body.address).toBe('New address');
    // onuSerial untouched (key was absent) even though the permission gate was denied
    expect(res.body.onuSerial).toBe('HWTC11112222');
  });

  it('200 — PUT WITHOUT onuSerial key + requireSchedulingWrite omitted entirely (legacy pass-through) still works', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-5', stageId: DEFAULT_STAGE_ID_PENDING, title: 'Before' });
    const { app } = buildApp({ repo }); // no requireSchedulingWrite injected at all

    const res = await request(app)
      .put('/api/scheduling/task-5')
      .set('Cookie', cookie)
      .send({ title: 'After' });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('After');
  });

  it('200 — onuSerial in body + requireSchedulingWrite omitted entirely (legacy pass-through, no guard wired) still saves it', async () => {
    // Mirrors the historical behaviour of tests that build the router without
    // injecting requireSchedulingWrite at all (e.g. buildApp() in
    // scheduling.routes.test.ts) — onuSerial must still be settable.
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-6', stageId: DEFAULT_STAGE_ID_PENDING, onuSerial: null });
    const { app } = buildApp({ repo });

    const res = await request(app)
      .put('/api/scheduling/task-6')
      .set('Cookie', cookie)
      .send({ onuSerial: 'HWTC11112222' });

    expect(res.status).toBe(200);
    expect(res.body.onuSerial).toBe('HWTC11112222');
  });
});
