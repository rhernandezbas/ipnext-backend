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
import { UpdateTaskStatus } from '../../application/use-cases/UpdateTaskStatus';
import { MoveTaskToStage } from '../../application/use-cases/MoveTaskToStage';
import { createSchedulingRouter } from '../../infrastructure/http/routes/scheduling.routes';
import { User } from '../../domain/entities/auth';
import { AuthProvider } from '../../domain/ports/AuthProvider';
import { Stage } from '../../domain/entities/workflow';

// FakeAuthProvider: implements AuthProvider port, always grants access
class FakeAuthProvider implements AuthProvider {
  async login() {
    return { user: { id: 'admin-1', username: 'testuser', email: 'test@test.com', role: 'admin' as const }, cookieValue: 'fake', cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' } };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(_token: string): Promise<User> {
    return { id: 'admin-1', username: 'testuser', email: 'test@test.com', role: 'admin' };
  }
}

// Default stage IDs used in InMemorySchedulingRepository — must be valid UUIDs for MoveStageSchema
const DEFAULT_STAGE_ID_PENDING     = '10000000-0000-4000-a000-000000000001';
const DEFAULT_STAGE_ID_IN_PROGRESS = '10000000-0000-4000-a000-000000000002';
const DEFAULT_STAGE_ID_COMPLETED   = '10000000-0000-4000-a000-000000000003';
const DEFAULT_STAGE_ID_CANCELLED   = '10000000-0000-4000-a000-000000000004';

// Default stages for InMemoryStageRepository — IDs must match those in InMemorySchedulingRepository
function makeDefaultStages(stageRepo: InMemoryStageRepository): void {
  const stages: Stage[] = [
    { id: DEFAULT_STAGE_ID_PENDING,     workflowId: 'wf-default', name: 'Nuevo',            category: 'nuevo',      order: 0 },
    { id: DEFAULT_STAGE_ID_IN_PROGRESS, workflowId: 'wf-default', name: 'En progreso',       category: 'enProgreso', order: 7 },
    { id: DEFAULT_STAGE_ID_COMPLETED,   workflowId: 'wf-default', name: 'Hecho',             category: 'hecho',      order: 9 },
    { id: DEFAULT_STAGE_ID_CANCELLED,   workflowId: 'wf-default', name: 'Anulado-Cancelado', category: 'hecho',      order: 10 },
  ];
  stages.forEach(s => stageRepo.addDirect(s));
}


function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const repo = new InMemorySchedulingRepository();
  const stageRepo = new InMemoryStageRepository();
  makeDefaultStages(stageRepo);

  const listTasks = new ListTasks(repo);
  const getTask = new GetTask(repo);
  const createTask = new CreateTask(repo);
  const updateTask = new UpdateTask(repo);
  const deleteTask = new DeleteTask(repo);
  const updateTaskStatus = new UpdateTaskStatus(repo, stageRepo);
  const moveTaskToStage = new MoveTaskToStage(repo, stageRepo);

  const authProvider = new FakeAuthProvider();

  app.use('/api/scheduling', createSchedulingRouter(listTasks, getTask, createTask, updateTask, deleteTask, updateTaskStatus, moveTaskToStage, authProvider));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

// ─── REQ-AUTH: All routes reject unauthenticated requests ───────────────────

describe('Auth: routes reject missing cookie', () => {
  it('REQ-AUTH-1: GET / → 401 UNAUTHORIZED', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/scheduling');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('REQ-AUTH-2: GET /:id → 401 UNAUTHORIZED', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/scheduling/1');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('REQ-AUTH-3: POST / → 401 UNAUTHORIZED', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/scheduling').send({ title: 'test' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('REQ-AUTH-4: PUT /:id → 401 UNAUTHORIZED', async () => {
    const app = buildApp();
    const res = await request(app).put('/api/scheduling/1').send({ title: 'test' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('REQ-AUTH-5: DELETE /:id → 401 UNAUTHORIZED', async () => {
    const app = buildApp();
    const res = await request(app).delete('/api/scheduling/1');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('REQ-AUTH-6: PATCH /:id/status → 401 UNAUTHORIZED', async () => {
    const app = buildApp();
    const res = await request(app).patch('/api/scheduling/1/status').send({ status: 'completed' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('REQ-AUTH-7: PATCH /:id/stage → 401 UNAUTHORIZED', async () => {
    const app = buildApp();
    const res = await request(app).patch('/api/scheduling/1/stage').send({ stageId: DEFAULT_STAGE_ID_COMPLETED });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });
});

// ─── Happy path tests (with cookie) ─────────────────────────────────────────

describe('GET /api/scheduling', () => {
  it('returns 200 with array of 7 tasks', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/scheduling')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(7);
  });
});

describe('POST /api/scheduling', () => {
  it('returns 201 with new task', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/scheduling')
      .set('Cookie', 'auth_token=fake')
      .send({
        title: 'Tarea de test',
        description: 'Descripción test',
        assignedTo: 'Técnico',
        assignedToId: 'admin-1',
        clientId: null,
        clientName: null,
        priority: 'normal',
        scheduledDate: '2026-05-10',
        scheduledTime: '09:00',
        estimatedHours: 1,
        address: 'Test 123',
        coordinates: null,
        category: 'other',
        completedAt: null,
        notes: '',
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.title).toBe('Tarea de test');
    expect(res.body.stageId).toBeTruthy();
    expect(res.body.stageCategory).toBe('nuevo');
    expect(res.body.status).toBe('pending');
  });
});

describe('PUT /api/scheduling/:id', () => {
  it('returns 200 with updated task', async () => {
    const app = buildApp();
    const res = await request(app)
      .put('/api/scheduling/1')
      .set('Cookie', 'auth_token=fake')
      .send({ title: 'Título actualizado' });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Título actualizado');
  });

  it('returns 404 for unknown id', async () => {
    const app = buildApp();
    const res = await request(app)
      .put('/api/scheduling/9999')
      .set('Cookie', 'auth_token=fake')
      .send({ title: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/scheduling/:id/status (deprecated)', () => {
  it('REQ-STAGE-DEP-1: returns 200 with updated status (deprecated shim)', async () => {
    const app = buildApp();
    const res = await request(app)
      .patch('/api/scheduling/1/status')
      .set('Cookie', 'auth_token=fake')
      .send({ status: 'completed' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.stageId).toBeTruthy();
    expect(res.body.stageCategory).toBe('hecho');
  });

  it('returns 404 for unknown id', async () => {
    const app = buildApp();
    const res = await request(app)
      .patch('/api/scheduling/9999/status')
      .set('Cookie', 'auth_token=fake')
      .send({ status: 'completed' });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/scheduling/:id/stage (new)', () => {
  it('REQ-STAGE-1: returns 200 with stageId and stageCategory', async () => {
    const app = buildApp();
    const res = await request(app)
      .patch('/api/scheduling/1/stage')
      .set('Cookie', 'auth_token=fake')
      .send({ stageId: DEFAULT_STAGE_ID_COMPLETED });

    expect(res.status).toBe(200);
    expect(res.body.stageId).toBe(DEFAULT_STAGE_ID_COMPLETED);
    expect(res.body.stageCategory).toBe('hecho');
    expect(res.body.status).toBe('completed');
  });

  it('REQ-STAGE-2: non-existent stageId → 404 STAGE_NOT_FOUND', async () => {
    const app = buildApp();
    const res = await request(app)
      .patch('/api/scheduling/1/stage')
      .set('Cookie', 'auth_token=fake')
      .send({ stageId: '550e8400-e29b-41d4-a716-446655440999' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('STAGE_NOT_FOUND');
  });

  it('REQ-STAGE-3: missing stageId → 400 VALIDATION_ERROR', async () => {
    const app = buildApp();
    const res = await request(app)
      .patch('/api/scheduling/1/stage')
      .set('Cookie', 'auth_token=fake')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('REQ-STAGE-4: unknown task id → 404 TASK_NOT_FOUND', async () => {
    const app = buildApp();
    const res = await request(app)
      .patch('/api/scheduling/9999/stage')
      .set('Cookie', 'auth_token=fake')
      .send({ stageId: DEFAULT_STAGE_ID_COMPLETED });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TASK_NOT_FOUND');
  });

  it('REQ-STAGE-COMPLETED-1: moving to hecho stage auto-sets completedAt', async () => {
    const app = buildApp();
    const res = await request(app)
      .patch('/api/scheduling/1/stage')
      .set('Cookie', 'auth_token=fake')
      .send({ stageId: DEFAULT_STAGE_ID_COMPLETED });

    expect(res.status).toBe(200);
    expect(res.body.completedAt).toBeTruthy();
  });
});

describe('DELETE /api/scheduling/:id', () => {
  it('returns 204 on successful delete', async () => {
    const app = buildApp();
    const res = await request(app)
      .delete('/api/scheduling/1')
      .set('Cookie', 'auth_token=fake');
    expect(res.status).toBe(204);
  });

  it('returns 404 for unknown id', async () => {
    const app = buildApp();
    const res = await request(app)
      .delete('/api/scheduling/9999')
      .set('Cookie', 'auth_token=fake');
    expect(res.status).toBe(404);
  });
});

// ─── REQ-CREATE: Validation tests ───────────────────────────────────────────

describe('POST /api/scheduling - validation', () => {
  const validBody = {
    title: 'Test task',
    priority: 'normal',
    scheduledDate: '2026-05-10',
    scheduledTime: '09:00',
    estimatedHours: 1,
    category: 'other',
  };

  it('REQ-CREATE-2: missing title → 400 VALIDATION_ERROR', async () => {
    const app = buildApp();
    const { title: _title, ...bodyWithoutTitle } = validBody;
    const res = await request(app)
      .post('/api/scheduling')
      .set('Cookie', 'auth_token=fake')
      .send(bodyWithoutTitle);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('REQ-CREATE-3: invalid estimatedHours type → 400 VALIDATION_ERROR', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/scheduling')
      .set('Cookie', 'auth_token=fake')
      .send({ ...validBody, estimatedHours: 'two' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('REQ-CREATE-5: invalid priority value → 400 VALIDATION_ERROR', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/scheduling')
      .set('Cookie', 'auth_token=fake')
      .send({ ...validBody, priority: 'critical' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('REQ-CREATE-6: invalid category value → 400 VALIDATION_ERROR', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/scheduling')
      .set('Cookie', 'auth_token=fake')
      .send({ ...validBody, category: 'demolition' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('REQ-CREATE-7: scheduledDate and scheduledTime as null → 201 created', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/scheduling')
      .set('Cookie', 'auth_token=fake')
      .send({ ...validBody, scheduledDate: null, scheduledTime: null });

    expect(res.status).toBe(201);
    expect(res.body.scheduledDate).toBeNull();
    expect(res.body.scheduledTime).toBeNull();
  });
});

// ─── REQ-UPDATE: Validation tests ───────────────────────────────────────────

describe('PUT /api/scheduling/:id - validation', () => {
  it('REQ-UPDATE-3: invalid estimatedHours type → 400 VALIDATION_ERROR', async () => {
    const app = buildApp();
    const res = await request(app)
      .put('/api/scheduling/1')
      .set('Cookie', 'auth_token=fake')
      .send({ estimatedHours: 'not-a-number' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

// ─── REQ-STATUS: Validation tests ───────────────────────────────────────────

describe('PATCH /api/scheduling/:id/status - validation', () => {
  it('REQ-STATUS-2: status "done" → 400 VALIDATION_ERROR', async () => {
    const app = buildApp();
    const res = await request(app)
      .patch('/api/scheduling/1/status')
      .set('Cookie', 'auth_token=fake')
      .send({ status: 'done' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('REQ-STATUS-3: empty body → 400 VALIDATION_ERROR', async () => {
    const app = buildApp();
    const res = await request(app)
      .patch('/api/scheduling/1/status')
      .set('Cookie', 'auth_token=fake')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

// ─── REQ-STATUS-7 / REQ-STAGE-PROJECTNAME-1: projectName returned ──────────

describe('PATCH /:id/stage - projectName', () => {
  it('REQ-STAGE-PROJECTNAME-1: response includes projectName when task has projectId', async () => {
    const repo = new InMemorySchedulingRepository();
    const stageRepo = new InMemoryStageRepository();
    makeDefaultStages(stageRepo);

    const created = await repo.createTask({
      title: 'Task with project',
      description: null,
      assignedTo: null,
      assignedToId: null,
      clientId: null,
      clientName: null,
      stageId: DEFAULT_STAGE_ID_PENDING,
      priority: 'normal',
      scheduledDate: '2026-05-10',
      scheduledTime: '09:00',
      estimatedHours: 1,
      address: null,
      coordinates: null,
      category: 'other',
      projectId: 'proj-1',
      projectName: 'My Project',
      completedAt: null,
      notes: null,
    });

    const app = express();
    app.use(cookieParser());
    app.use(express.json());

    const moveTaskToStage = new MoveTaskToStage(repo, stageRepo);
    const updateTaskStatus = new UpdateTaskStatus(repo, stageRepo);
    app.use('/api/scheduling', createSchedulingRouter(
      new ListTasks(repo), new GetTask(repo), new CreateTask(repo),
      new UpdateTask(repo), new DeleteTask(repo), updateTaskStatus,
      moveTaskToStage, new FakeAuthProvider(),
    ));
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    });

    const res = await request(app)
      .patch(`/api/scheduling/${created.id}/stage`)
      .set('Cookie', 'auth_token=fake')
      .send({ stageId: DEFAULT_STAGE_ID_COMPLETED });

    expect(res.status).toBe(200);
    expect(res.body.projectName).toBe('My Project');
  });
});

// ─── REQ-STATUS-4/5: completedAt behavior ────────────────────────────────────

describe('PATCH /:id/stage - completedAt', () => {
  it('REQ-STAGE-COMPLETED-1: moving to hecho stage auto-sets completedAt', async () => {
    const repo = new InMemorySchedulingRepository();
    const stageRepo = new InMemoryStageRepository();
    makeDefaultStages(stageRepo);

    const created = await repo.createTask({
      title: 'completedAt test',
      description: null,
      assignedTo: null,
      assignedToId: null,
      clientId: null,
      clientName: null,
      stageId: DEFAULT_STAGE_ID_PENDING,
      priority: 'normal',
      scheduledDate: '2026-05-10',
      scheduledTime: '09:00',
      estimatedHours: 1,
      address: null,
      coordinates: null,
      category: 'other',
      projectId: null,
      projectName: null,
      completedAt: null,
      notes: null,
    });

    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    const moveTaskToStage = new MoveTaskToStage(repo, stageRepo);
    const updateTaskStatus = new UpdateTaskStatus(repo, stageRepo);
    app.use('/api/scheduling', createSchedulingRouter(
      new ListTasks(repo), new GetTask(repo), new CreateTask(repo),
      new UpdateTask(repo), new DeleteTask(repo), updateTaskStatus,
      moveTaskToStage, new FakeAuthProvider(),
    ));
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
      res.status(500).json({ error: 'Internal server error' });
    });

    const res = await request(app)
      .patch(`/api/scheduling/${created.id}/stage`)
      .set('Cookie', 'auth_token=fake')
      .send({ stageId: DEFAULT_STAGE_ID_COMPLETED });

    expect(res.status).toBe(200);
    expect(res.body.completedAt).toBeTruthy();
    expect(new Date(res.body.completedAt).toISOString()).toBe(res.body.completedAt);
  });

  it('REQ-STAGE-COMPLETED-2: moving to non-hecho stage preserves completedAt', async () => {
    const repo = new InMemorySchedulingRepository();
    const stageRepo = new InMemoryStageRepository();
    makeDefaultStages(stageRepo);

    const created = await repo.createTask({
      title: 'preserve completedAt test',
      description: null,
      assignedTo: null,
      assignedToId: null,
      clientId: null,
      clientName: null,
      stageId: DEFAULT_STAGE_ID_PENDING,
      priority: 'normal',
      scheduledDate: '2026-05-10',
      scheduledTime: '09:00',
      estimatedHours: 1,
      address: null,
      coordinates: null,
      category: 'other',
      projectId: null,
      projectName: null,
      completedAt: null,
      notes: null,
    });

    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    const moveTaskToStage = new MoveTaskToStage(repo, stageRepo);
    const updateTaskStatus = new UpdateTaskStatus(repo, stageRepo);
    app.use('/api/scheduling', createSchedulingRouter(
      new ListTasks(repo), new GetTask(repo), new CreateTask(repo),
      new UpdateTask(repo), new DeleteTask(repo), updateTaskStatus,
      moveTaskToStage, new FakeAuthProvider(),
    ));
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
      res.status(500).json({ error: 'Internal server error' });
    });

    // First: move to hecho → completedAt set
    const completedRes = await request(app)
      .patch(`/api/scheduling/${created.id}/stage`)
      .set('Cookie', 'auth_token=fake')
      .send({ stageId: DEFAULT_STAGE_ID_COMPLETED });
    expect(completedRes.status).toBe(200);
    const originalCompletedAt = completedRes.body.completedAt;
    expect(originalCompletedAt).toBeTruthy();

    // Second: move to enProgreso → completedAt preserved
    const inProgressRes = await request(app)
      .patch(`/api/scheduling/${created.id}/stage`)
      .set('Cookie', 'auth_token=fake')
      .send({ stageId: DEFAULT_STAGE_ID_IN_PROGRESS });
    expect(inProgressRes.status).toBe(200);
    expect(inProgressRes.body.completedAt).toBe(originalCompletedAt);
  });
});

// ─── REQ-LIST-3 / REQ-SHAPE-2: response fields ───────────────────────────────

describe('Response shape: stageId, stageCategory, status (deprecated)', () => {
  it('GET /api/scheduling — every item has stageId, stageCategory, status', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/scheduling')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const task of res.body) {
      expect(task).toHaveProperty('stageId');
      expect(task).toHaveProperty('stageCategory');
      expect(task).toHaveProperty('status');
      expect(task).toHaveProperty('projectName');
    }
  });

  it('POST /api/scheduling — response has stageId, stageCategory, status', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/scheduling')
      .set('Cookie', 'auth_token=fake')
      .send({
        title: 'shape test',
        priority: 'normal',
        estimatedHours: 1,
        category: 'other',
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('stageId');
    expect(res.body).toHaveProperty('stageCategory');
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('projectName');
  });
});

// ─── REQ-STAGE-DEFAULT-1: POST without stageId defaults to "Nuevo" ────────────

describe('REQ-STAGE-DEFAULT-1: create without stageId defaults to Default workflow Nuevo', () => {
  it('created task has stageCategory: nuevo and status: pending', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/scheduling')
      .set('Cookie', 'auth_token=fake')
      .send({
        title: 'Default stage test',
        priority: 'normal',
        estimatedHours: 1,
        category: 'installation',
      });

    expect(res.status).toBe(201);
    expect(res.body.stageCategory).toBe('nuevo');
    expect(res.body.status).toBe('pending');
  });

  it('REQ-STAGE-DEFAULT-1 (production path): stageId in response is the real UUID, not the sentinel', async () => {
    // This test verifies that when stageRepo is injected into the router,
    // the default stageId resolved is the real UUID from the stage repo — NOT 'stage-default-nuevo'.
    const repo = new InMemorySchedulingRepository();
    const stageRepo = new InMemoryStageRepository();
    makeDefaultStages(stageRepo);

    const app = express();
    app.use(cookieParser());
    app.use(express.json());

    const listTasks = new ListTasks(repo);
    const getTask = new GetTask(repo);
    const createTask = new CreateTask(repo);
    const updateTask = new UpdateTask(repo);
    const deleteTask = new DeleteTask(repo);
    const updateTaskStatus = new UpdateTaskStatus(repo, stageRepo);
    const moveTaskToStage = new MoveTaskToStage(repo, stageRepo);

    app.use('/api/scheduling', createSchedulingRouter(
      listTasks, getTask, createTask, updateTask, deleteTask,
      updateTaskStatus, moveTaskToStage, new FakeAuthProvider(), stageRepo,
    ));
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    });

    const res = await request(app)
      .post('/api/scheduling')
      .set('Cookie', 'auth_token=fake')
      .send({
        title: 'Default stage real UUID test',
        priority: 'normal',
        estimatedHours: 1,
        category: 'installation',
      });

    expect(res.status).toBe(201);
    expect(res.body.stageId).toBe(DEFAULT_STAGE_ID_PENDING);
    expect(res.body.stageCategory).toBe('nuevo');
    expect(res.body.status).toBe('pending');
  });

  it('REQ-STAGE-DEFAULT-1: returns 500 INTERNAL_ERROR when stageRepo returns null (unseeded env)', async () => {
    // Verifies the route returns 500 with INTERNAL_ERROR code when default stage is missing
    const repo = new InMemorySchedulingRepository();
    const stageRepo = new InMemoryStageRepository(); // empty — no stages seeded

    const app = express();
    app.use(cookieParser());
    app.use(express.json());

    const updateTaskStatus = new UpdateTaskStatus(repo, stageRepo);
    const moveTaskToStage = new MoveTaskToStage(repo, stageRepo);

    app.use('/api/scheduling', createSchedulingRouter(
      new ListTasks(repo), new GetTask(repo), new CreateTask(repo),
      new UpdateTask(repo), new DeleteTask(repo), updateTaskStatus,
      moveTaskToStage, new FakeAuthProvider(), stageRepo,
    ));
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
      res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    });

    const res = await request(app)
      .post('/api/scheduling')
      .set('Cookie', 'auth_token=fake')
      .send({
        title: 'Unseeded env test',
        priority: 'normal',
        estimatedHours: 1,
        category: 'installation',
      });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  });
});

// ─── GET /:id shape ──────────────────────────────────────────────────────────

describe('GET /api/scheduling/:id', () => {
  it('REQ-GET-1: returns 200 with task body when id exists', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/scheduling/1')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('1');
    expect(res.body).toHaveProperty('stageId');
    expect(res.body).toHaveProperty('stageCategory');
    expect(res.body).toHaveProperty('status');
  });

  it('REQ-GET-2: returns 404 with TASK_NOT_FOUND when id does not exist', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/scheduling/9999')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TASK_NOT_FOUND');
  });
});
