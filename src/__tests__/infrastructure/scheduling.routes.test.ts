import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { ListTasks } from '../../application/use-cases/ListTasks';
import { GetTask } from '../../application/use-cases/GetTask';
import { CreateTask } from '../../application/use-cases/CreateTask';
import { UpdateTask } from '../../application/use-cases/UpdateTask';
import { DeleteTask } from '../../application/use-cases/DeleteTask';
import { UpdateTaskStatus } from '../../application/use-cases/UpdateTaskStatus';
import { createSchedulingRouter } from '../../infrastructure/http/routes/scheduling.routes';

function buildApp() {
  const app = express();
  app.use(express.json());

  const repo = new InMemorySchedulingRepository();
  const listTasks = new ListTasks(repo);
  const getTask = new GetTask(repo);
  const createTask = new CreateTask(repo);
  const updateTask = new UpdateTask(repo);
  const deleteTask = new DeleteTask(repo);
  const updateTaskStatus = new UpdateTaskStatus(repo);

  app.use('/api/scheduling', createSchedulingRouter(listTasks, getTask, createTask, updateTask, deleteTask, updateTaskStatus));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

describe('GET /api/scheduling', () => {
  it('returns 200 with array of 6 tasks', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/scheduling');

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
      .send({ title: 'Título actualizado' });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Título actualizado');
  });

  it('returns 404 for unknown id', async () => {
    const app = buildApp();
    const res = await request(app).put('/api/scheduling/9999').send({ title: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/scheduling/:id/status', () => {
  it('returns 200 with updated status', async () => {
    const app = buildApp();
    const res = await request(app)
      .patch('/api/scheduling/1/status')
      .send({ status: 'completed' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
  });

  it('returns 404 for unknown id', async () => {
    const app = buildApp();
    const res = await request(app)
      .patch('/api/scheduling/9999/status')
      .send({ status: 'completed' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/scheduling/:id', () => {
  it('returns 204 on successful delete', async () => {
    const app = buildApp();
    const res = await request(app).delete('/api/scheduling/1');
    expect(res.status).toBe(204);
  });

  it('returns 404 for unknown id', async () => {
    const app = buildApp();
    const res = await request(app).delete('/api/scheduling/9999');
    expect(res.status).toBe(404);
  });
});
