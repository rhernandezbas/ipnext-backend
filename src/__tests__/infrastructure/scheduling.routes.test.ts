import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { ListTasks } from '../../application/use-cases/ListTasks';
import { GetTask } from '../../application/use-cases/GetTask';
import { CreateTask } from '../../application/use-cases/CreateTask';
import { UpdateTask } from '../../application/use-cases/UpdateTask';
import { DeleteTask } from '../../application/use-cases/DeleteTask';
import { UpdateTaskStatus } from '../../application/use-cases/UpdateTaskStatus';
import { createSchedulingRouter } from '../../infrastructure/http/routes/scheduling.routes';
import { User } from '../../domain/entities/auth';
import { AuthProvider } from '../../domain/ports/AuthProvider';

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

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const repo = new InMemorySchedulingRepository();
  const listTasks = new ListTasks(repo);
  const getTask = new GetTask(repo);
  const createTask = new CreateTask(repo);
  const updateTask = new UpdateTask(repo);
  const deleteTask = new DeleteTask(repo);
  const updateTaskStatus = new UpdateTaskStatus(repo);

  const authProvider = new FakeAuthProvider();

  app.use('/api/scheduling', createSchedulingRouter(listTasks, getTask, createTask, updateTask, deleteTask, updateTaskStatus, authProvider));

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
});

// ─── Happy path tests (with cookie) ─────────────────────────────────────────

describe('GET /api/scheduling', () => {
  it('returns 200 with array of 6 tasks', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/scheduling')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(6);
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
        status: 'pending',
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

describe('PATCH /api/scheduling/:id/status', () => {
  it('returns 200 with updated status', async () => {
    const app = buildApp();
    const res = await request(app)
      .patch('/api/scheduling/1/status')
      .set('Cookie', 'auth_token=fake')
      .send({ status: 'completed' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
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
    description: null,
    assignedTo: null,
    assignedToId: null,
    clientId: null,
    clientName: null,
    status: 'pending',
    priority: 'normal',
    scheduledDate: '2026-05-10',
    scheduledTime: '09:00',
    estimatedHours: 1,
    address: null,
    coordinates: null,
    category: 'other',
    completedAt: null,
    notes: null,
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

  it('REQ-CREATE-4: invalid status value → 400 VALIDATION_ERROR', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/scheduling')
      .set('Cookie', 'auth_token=fake')
      .send({ ...validBody, status: 'unknown_value' });

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

  it('REQ-UPDATE-4: invalid status value → 400 VALIDATION_ERROR', async () => {
    const app = buildApp();
    const res = await request(app)
      .put('/api/scheduling/1')
      .set('Cookie', 'auth_token=fake')
      .send({ status: 'unknown_value' });

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

// ─── REQ-STATUS-7: projectName returned from PATCH /:id/status ──────────────

describe('PATCH /api/scheduling/:id/status - projectName', () => {
  it('REQ-STATUS-7: response includes projectName when task has projectId', async () => {
    // Use a repo with a task that has projectId and projectName set
    const repo = new InMemorySchedulingRepository();
    // Seed a task with projectId and projectName; capture the returned id
    const created = await repo.createTask({
      title: 'Task with project',
      description: null,
      assignedTo: null,
      assignedToId: null,
      clientId: null,
      clientName: null,
      status: 'pending',
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

    const listTasks = new ListTasks(repo);
    const getTask = new GetTask(repo);
    const createTask = new CreateTask(repo);
    const updateTask = new UpdateTask(repo);
    const deleteTask = new DeleteTask(repo);
    const updateTaskStatus = new UpdateTaskStatus(repo);

    app.use('/api/scheduling', createSchedulingRouter(listTasks, getTask, createTask, updateTask, deleteTask, updateTaskStatus, new FakeAuthProvider()));
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    });

    const res = await request(app)
      .patch(`/api/scheduling/${created.id}/status`)
      .set('Cookie', 'auth_token=fake')
      .send({ status: 'completed' });

    expect(res.status).toBe(200);
    expect(res.body.projectName).toBe('My Project');
  });
});

// ─── REQ-GET-1/2: GET /api/scheduling/:id ────────────────────────────────────
// TDD note: tests added retroactively for coverage; route was already implemented.
// Tests verify the route correctly handles the 200 and 404 cases.

describe('GET /api/scheduling/:id', () => {
  it('REQ-GET-1: returns 200 with task body when id exists', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/scheduling/1')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('1');
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

// ─── REQ-STATUS-4/5: completedAt behavior ────────────────────────────────────
// TDD note: tests added retroactively for coverage; InMemorySchedulingRepository
// already implements REQ-STATUS-4 (line 161) and REQ-STATUS-5 (preserves existing).

describe('PATCH /api/scheduling/:id/status - completedAt', () => {
  it('REQ-STATUS-4: setting status to "completed" auto-sets completedAt', async () => {
    const repo = new InMemorySchedulingRepository();
    const created = await repo.createTask({
      title: 'completedAt test',
      description: null,
      assignedTo: null,
      assignedToId: null,
      clientId: null,
      clientName: null,
      status: 'pending',
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
    const listTasks = new ListTasks(repo);
    const getTask = new GetTask(repo);
    const createTask = new CreateTask(repo);
    const updateTask = new UpdateTask(repo);
    const deleteTask = new DeleteTask(repo);
    const updateTaskStatus = new UpdateTaskStatus(repo);
    app.use('/api/scheduling', createSchedulingRouter(listTasks, getTask, createTask, updateTask, deleteTask, updateTaskStatus, new FakeAuthProvider()));
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
      res.status(500).json({ error: 'Internal server error' });
    });

    const res = await request(app)
      .patch(`/api/scheduling/${created.id}/status`)
      .set('Cookie', 'auth_token=fake')
      .send({ status: 'completed' });

    expect(res.status).toBe(200);
    expect(res.body.completedAt).toBeTruthy();
    expect(new Date(res.body.completedAt).toISOString()).toBe(res.body.completedAt);
  });

  it('REQ-STATUS-5: changing status from "completed" to "in_progress" preserves completedAt', async () => {
    const repo = new InMemorySchedulingRepository();
    const created = await repo.createTask({
      title: 'preserve completedAt test',
      description: null,
      assignedTo: null,
      assignedToId: null,
      clientId: null,
      clientName: null,
      status: 'pending',
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
    const listTasks = new ListTasks(repo);
    const getTask = new GetTask(repo);
    const createTask = new CreateTask(repo);
    const updateTask = new UpdateTask(repo);
    const deleteTask = new DeleteTask(repo);
    const updateTaskStatus = new UpdateTaskStatus(repo);
    app.use('/api/scheduling', createSchedulingRouter(listTasks, getTask, createTask, updateTask, deleteTask, updateTaskStatus, new FakeAuthProvider()));
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
      res.status(500).json({ error: 'Internal server error' });
    });

    // First: set to completed → completedAt is set
    const completedRes = await request(app)
      .patch(`/api/scheduling/${created.id}/status`)
      .set('Cookie', 'auth_token=fake')
      .send({ status: 'completed' });
    expect(completedRes.status).toBe(200);
    const originalCompletedAt = completedRes.body.completedAt;
    expect(originalCompletedAt).toBeTruthy();

    // Second: change to in_progress → completedAt must be preserved
    const inProgressRes = await request(app)
      .patch(`/api/scheduling/${created.id}/status`)
      .set('Cookie', 'auth_token=fake')
      .send({ status: 'in_progress' });
    expect(inProgressRes.status).toBe(200);
    expect(inProgressRes.body.completedAt).toBe(originalCompletedAt);
  });
});

// ─── REQ-LIST-3 / REQ-SHAPE-1: projectName in list, create, update ───────────
// TDD note: tests added retroactively for coverage; routes already wire projectName correctly.

describe('projectName field presence in GET list, POST create, PUT update', () => {
  it('REQ-LIST-3: GET /api/scheduling — every item has projectName key (may be null)', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/scheduling')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const task of res.body) {
      expect(Object.prototype.hasOwnProperty.call(task, 'projectName')).toBe(true);
    }
  });

  it('REQ-SHAPE-1a: POST /api/scheduling with projectId: null → response has projectName: null', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/scheduling')
      .set('Cookie', 'auth_token=fake')
      .send({
        title: 'projectName shape test',
        description: null,
        assignedTo: null,
        assignedToId: null,
        clientId: null,
        clientName: null,
        status: 'pending',
        priority: 'normal',
        scheduledDate: '2026-05-10',
        scheduledTime: '09:00',
        estimatedHours: 1,
        address: null,
        coordinates: null,
        category: 'other',
        completedAt: null,
        notes: null,
      });

    expect(res.status).toBe(201);
    expect(Object.prototype.hasOwnProperty.call(res.body, 'projectName')).toBe(true);
    expect(res.body.projectName).toBeNull();
  });

  it('REQ-SHAPE-1b: PUT /api/scheduling/:id — response has projectName key', async () => {
    const app = buildApp();
    const res = await request(app)
      .put('/api/scheduling/1')
      .set('Cookie', 'auth_token=fake')
      .send({ title: 'Updated for projectName test' });

    expect(res.status).toBe(200);
    expect(Object.prototype.hasOwnProperty.call(res.body, 'projectName')).toBe(true);
  });
});
