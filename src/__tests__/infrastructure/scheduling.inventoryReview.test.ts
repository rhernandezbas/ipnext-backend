/**
 * TDD — PATCH /api/scheduling/:id/inventory-review
 *
 * Covers SCEN-RV-1 through SCEN-RV-5 from the spec.
 */

import request from 'supertest';
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import cookieParser from 'cookie-parser';

import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { ListTasks } from '../../application/use-cases/ListTasks';
import { GetTask } from '../../application/use-cases/GetTask';
import { CreateTask } from '../../application/use-cases/CreateTask';
import { UpdateTask } from '../../application/use-cases/UpdateTask';
import { DeleteTask } from '../../application/use-cases/DeleteTask';
import { MoveTaskToStage } from '../../application/use-cases/MoveTaskToStage';
import { SetTaskInventoryReview } from '../../application/use-cases/SetTaskInventoryReview';
import { createSchedulingRouter } from '../../infrastructure/http/routes/scheduling.routes';
import { InMemoryStageRepository } from '../../infrastructure/adapters/in-memory/InMemoryStageRepository';
import { User } from '../../domain/entities/auth';
import { AuthProvider } from '../../domain/ports/AuthProvider';
import { EntityLookup } from '../../domain/ports/EntityLookup';
import { Stage } from '../../domain/entities/workflow';

// ── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_STAGE_ID_PENDING = '10000000-0000-4000-a000-000000000001';

class StubLookup implements EntityLookup {
  async findById(_id: string) { return null; }
}

class FakeAuthProvider implements AuthProvider {
  async login() {
    return {
      user: { id: 'admin-1', username: 'testuser', email: 'test@test.com', role: 'admin' as const },
      cookieValue: 'fake',
      cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' },
    };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(_token: string): Promise<User> {
    return { id: 'admin-1', username: 'testuser', email: 'test@test.com', role: 'admin' };
  }
}

function buildApp(requireInventoryWrite?: RequestHandler) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const repo = new InMemorySchedulingRepository();
  const stageRepo = new InMemoryStageRepository();
  const stages: Stage[] = [
    { id: DEFAULT_STAGE_ID_PENDING, workflowId: 'wf-default', name: 'Nuevo', code: 'nuevo', category: 'nuevo', order: 0, color: null },
  ];
  stages.forEach(s => stageRepo.addDirect(s));

  const authProvider = new FakeAuthProvider();
  const emptyLookup = new StubLookup();

  const setTaskInventoryReview = new SetTaskInventoryReview(repo);

  const router = createSchedulingRouter(
    new ListTasks(repo),
    new GetTask(repo),
    new CreateTask(repo, emptyLookup, emptyLookup, emptyLookup, emptyLookup, emptyLookup),
    new UpdateTask(repo, emptyLookup, emptyLookup, emptyLookup, emptyLookup, emptyLookup),
    new DeleteTask(repo),
    new MoveTaskToStage(repo, stageRepo),
    authProvider,
    stageRepo,
    undefined,            // checklist
    setTaskInventoryReview,
    undefined,            // bulkMoveTasksToStage
    undefined,            // resendDeps
    undefined,            // getTaskActivity
    requireInventoryWrite,
  );
  app.use('/api/scheduling', router);

  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    res.status(500).json({ error: 'Internal server error' });
  });

  return { app, repo };
}

const CREATE_INPUT = {
  title: 'Tarea de prueba RV',
  description: null,
  stageId: DEFAULT_STAGE_ID_PENDING,
  priority: 'normal',
  estimatedHours: 1,
  address: null,
  coordinates: null,
  category: 'other',
  completedAt: null,
  notes: null,
  startDate: null,
  endDate: null,
  customerId: null,
  contractId: null,
  partnerId: null,
  reporterId: null,
  assigneeId: null,
  travelTimeTo: null,
  travelTimeFrom: null,
};

// ── SCEN-RV-5: new tasks default to false ────────────────────────────────────

describe('SCEN-RV-5: GET /api/scheduling/:id returns reviewedByInventory: false by default', () => {
  it('new task has reviewedByInventory: false', async () => {
    const { app, repo } = buildApp();
    const task = await repo.createTask(CREATE_INPUT);

    const res = await request(app)
      .get(`/api/scheduling/${task.id}`)
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('reviewedByInventory', false);
  });
});

// ── SCEN-RV-1: set to true ────────────────────────────────────────────────────

describe('SCEN-RV-1: PATCH /api/scheduling/:id/inventory-review — set to true', () => {
  it('returns 200 with reviewedByInventory: true', async () => {
    const { app, repo } = buildApp();
    const task = await repo.createTask(CREATE_INPUT);

    const res = await request(app)
      .patch(`/api/scheduling/${task.id}/inventory-review`)
      .set('Cookie', 'auth_token=fake')
      .send({ reviewed: true });

    expect(res.status).toBe(200);
    expect(res.body.reviewedByInventory).toBe(true);
    expect(res.body.id).toBe(task.id);
  });
});

// ── SCEN-RV-2: unset to false ────────────────────────────────────────────────

describe('SCEN-RV-2: PATCH /api/scheduling/:id/inventory-review — unset to false', () => {
  it('returns 200 with reviewedByInventory: false after unsetting', async () => {
    const { app, repo } = buildApp();
    const task = await repo.createTask(CREATE_INPUT);
    await repo.setInventoryReview(task.id, true, null);

    const res = await request(app)
      .patch(`/api/scheduling/${task.id}/inventory-review`)
      .set('Cookie', 'auth_token=fake')
      .send({ reviewed: false });

    expect(res.status).toBe(200);
    expect(res.body.reviewedByInventory).toBe(false);
  });
});

// ── SCEN-RV-3: task not found ────────────────────────────────────────────────

describe('SCEN-RV-3: PATCH /api/scheduling/:id/inventory-review — task not found', () => {
  it('returns 404 with TASK_NOT_FOUND', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .patch('/api/scheduling/nonexistent-id/inventory-review')
      .set('Cookie', 'auth_token=fake')
      .send({ reviewed: true });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TASK_NOT_FOUND');
  });
});

// ── SCEN-RV-4: invalid body ──────────────────────────────────────────────────

describe('SCEN-RV-4: PATCH /api/scheduling/:id/inventory-review — invalid body', () => {
  it('returns 400 with VALIDATION_ERROR when reviewed is not boolean', async () => {
    const { app, repo } = buildApp();
    const task = await repo.createTask(CREATE_INPUT);

    const res = await request(app)
      .patch(`/api/scheduling/${task.id}/inventory-review`)
      .set('Cookie', 'auth_token=fake')
      .send({ reviewed: 'yes' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 with VALIDATION_ERROR when reviewed is missing', async () => {
    const { app, repo } = buildApp();
    const task = await repo.createTask(CREATE_INPUT);

    const res = await request(app)
      .patch(`/api/scheduling/${task.id}/inventory-review`)
      .set('Cookie', 'auth_token=fake')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

// ── Granular permission guard (inventory:write) ──────────────────────────────

describe('inventory-review is guarded by a granular permission (inventory:write), not auth-only', () => {
  it('returns 403 when the inventory:write guard denies', async () => {
    const deny: RequestHandler = (_req, res) => { res.status(403).json({ code: 'PERMISSION_DENIED' }); };
    const { app, repo } = buildApp(deny);
    const task = await repo.createTask(CREATE_INPUT);

    const res = await request(app)
      .patch(`/api/scheduling/${task.id}/inventory-review`)
      .set('Cookie', 'auth_token=fake')
      .send({ reviewed: true });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('allows the mutation when the guard passes', async () => {
    const allow: RequestHandler = (_req, _res, next) => next();
    const { app, repo } = buildApp(allow);
    const task = await repo.createTask(CREATE_INPUT);

    const res = await request(app)
      .patch(`/api/scheduling/${task.id}/inventory-review`)
      .set('Cookie', 'auth_token=fake')
      .send({ reviewed: true });

    expect(res.status).toBe(200);
    expect(res.body.reviewedByInventory).toBe(true);
  });
});

// ── F3 traceability: reviewedByInventoryAt + reviewedByInventoryUserName ──────

describe('F3 — PATCH /api/scheduling/:id/inventory-review — traceability fields', () => {
  it('response DTO exposes reviewedByInventoryAt (non-null) and reviewedByInventoryUserName when reviewed=true', async () => {
    const { app, repo } = buildApp();
    // The FakeAuthProvider returns id='admin-1'; seed the name for in-memory resolution
    repo.seedRbacUserName('admin-1', 'Test Admin');
    const task = await repo.createTask(CREATE_INPUT);

    const res = await request(app)
      .patch(`/api/scheduling/${task.id}/inventory-review`)
      .set('Cookie', 'auth_token=fake')
      .send({ reviewed: true });

    expect(res.status).toBe(200);
    expect(res.body.reviewedByInventory).toBe(true);
    expect(res.body.reviewedByInventoryAt).not.toBeNull();
    expect(res.body.reviewedByInventoryUserName).toBe('Test Admin');
  });

  it('response DTO exposes null fields when reviewed=false', async () => {
    const { app, repo } = buildApp();
    repo.seedRbacUserName('admin-1', 'Test Admin');
    const task = await repo.createTask(CREATE_INPUT);
    // First mark as reviewed
    await repo.setInventoryReview(task.id, true, 'admin-1');

    const res = await request(app)
      .patch(`/api/scheduling/${task.id}/inventory-review`)
      .set('Cookie', 'auth_token=fake')
      .send({ reviewed: false });

    expect(res.status).toBe(200);
    expect(res.body.reviewedByInventory).toBe(false);
    expect(res.body.reviewedByInventoryAt).toBeNull();
    expect(res.body.reviewedByInventoryUserName).toBeNull();
  });

  it('actorId in req.body is IGNORED — actor comes from req.user.id', async () => {
    const { app, repo } = buildApp();
    // Seed the legitimate user name
    repo.seedRbacUserName('admin-1', 'Real Admin');
    const task = await repo.createTask(CREATE_INPUT);

    const res = await request(app)
      .patch(`/api/scheduling/${task.id}/inventory-review`)
      .set('Cookie', 'auth_token=fake')
      .send({ reviewed: true, actorId: 'hacker-id' });

    expect(res.status).toBe(200);
    // actor should be 'admin-1' (from req.user), NOT 'hacker-id'
    // In-memory resolves 'admin-1' → 'Real Admin', so hacker's name doesn't appear
    expect(res.body.reviewedByInventoryUserName).toBe('Real Admin');
    expect(res.body.reviewedByInventoryUserName).not.toBe('hacker-id');
  });
});
