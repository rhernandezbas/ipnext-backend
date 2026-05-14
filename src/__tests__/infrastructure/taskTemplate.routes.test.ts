import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { InMemoryTaskTemplateRepository } from '../../infrastructure/adapters/in-memory/InMemoryTaskTemplateRepository';
import { ListTaskTemplates } from '../../application/use-cases/ListTaskTemplates';
import { GetTaskTemplate } from '../../application/use-cases/GetTaskTemplate';
import { CreateTaskTemplate } from '../../application/use-cases/CreateTaskTemplate';
import { UpdateTaskTemplate } from '../../application/use-cases/UpdateTaskTemplate';
import { DeleteTaskTemplate } from '../../application/use-cases/DeleteTaskTemplate';
import { createTaskTemplateRouter } from '../../infrastructure/http/routes/taskTemplate.routes';
import { User } from '../../domain/entities/auth';
import { AuthProvider } from '../../domain/ports/AuthProvider';

class FakeAuthProvider implements AuthProvider {
  async login() {
    return { user: { id: 'admin-1', username: 'u', email: 'u@u.com', role: 'admin' as const }, cookieValue: 'fake', cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' } };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(_token: string): Promise<User> {
    return { id: 'admin-1', username: 'u', email: 'u@u.com', role: 'admin' };
  }
}

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const repo = new InMemoryTaskTemplateRepository();
  app.use(
    '/api/task-templates',
    createTaskTemplateRouter(
      new ListTaskTemplates(repo),
      new GetTaskTemplate(repo),
      new CreateTaskTemplate(repo),
      new UpdateTaskTemplate(repo),
      new DeleteTaskTemplate(repo),
      new FakeAuthProvider(),
    ),
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

describe('TaskTemplate routes - auth', () => {
  it('GET / without cookie → 401', async () => {
    const res = await request(buildApp()).get('/api/task-templates');
    expect(res.status).toBe(401);
  });

  it('POST / without cookie → 401', async () => {
    const res = await request(buildApp()).post('/api/task-templates').send({});
    expect(res.status).toBe(401);
  });
});

describe('TaskTemplate routes - CRUD happy path', () => {
  it('GET / → 200 with seeded templates', async () => {
    const res = await request(buildApp()).get('/api/task-templates').set('Cookie', 'auth_token=fake');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty('name');
    expect(res.body[0]).toHaveProperty('description');
    expect(res.body[0]).toHaveProperty('category');
  });

  it('GET /:id with existing id → 200', async () => {
    const res = await request(buildApp()).get('/api/task-templates/1').set('Cookie', 'auth_token=fake');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('1');
  });

  it('GET /:id with unknown id → 404', async () => {
    const res = await request(buildApp()).get('/api/task-templates/9999').set('Cookie', 'auth_token=fake');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TEMPLATE_NOT_FOUND');
  });

  it('POST / with valid body → 201', async () => {
    const res = await request(buildApp())
      .post('/api/task-templates')
      .set('Cookie', 'auth_token=fake')
      .send({ name: 'Visita técnica', description: 'Diagnóstico en sitio', category: 'inspection' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Visita técnica');
    expect(res.body.category).toBe('inspection');
  });

  it('POST / with invalid category → 400', async () => {
    const res = await request(buildApp())
      .post('/api/task-templates')
      .set('Cookie', 'auth_token=fake')
      .send({ name: 'X', description: null, category: 'demolition' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('PUT /:id → 200 updates description', async () => {
    const res = await request(buildApp())
      .put('/api/task-templates/1')
      .set('Cookie', 'auth_token=fake')
      .send({ description: 'Nueva descripcion' });
    expect(res.status).toBe(200);
    expect(res.body.description).toBe('Nueva descripcion');
  });

  it('DELETE /:id → 204', async () => {
    const res = await request(buildApp())
      .delete('/api/task-templates/1')
      .set('Cookie', 'auth_token=fake');
    expect(res.status).toBe(204);
  });

  it('DELETE /:id unknown → 404', async () => {
    const res = await request(buildApp())
      .delete('/api/task-templates/9999')
      .set('Cookie', 'auth_token=fake');
    expect(res.status).toBe(404);
  });
});
