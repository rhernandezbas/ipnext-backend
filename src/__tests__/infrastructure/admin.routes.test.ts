import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { InMemoryAdminRepository } from '../../infrastructure/adapters/in-memory/InMemoryAdminRepository';
import { ListAdmins } from '../../application/use-cases/ListAdmins';
import { GetAdmin } from '../../application/use-cases/GetAdmin';
import { CreateAdmin } from '../../application/use-cases/CreateAdmin';
import { UpdateAdmin } from '../../application/use-cases/UpdateAdmin';
import { DeleteAdmin } from '../../application/use-cases/DeleteAdmin';
import { GetAdminActivityLog } from '../../application/use-cases/GetAdminActivityLog';
import { createAdminRouter } from '../../infrastructure/http/routes/admin.routes';

function buildApp() {
  const app = express();
  app.use(express.json());

  const repo = new InMemoryAdminRepository();
  const listAdmins = new ListAdmins(repo);
  const getAdmin = new GetAdmin(repo);
  const createAdmin = new CreateAdmin(repo);
  const updateAdmin = new UpdateAdmin(repo);
  const deleteAdmin = new DeleteAdmin(repo);
  const getActivityLog = new GetAdminActivityLog(repo);

  app.use('/api/admins', createAdminRouter(listAdmins, getAdmin, createAdmin, updateAdmin, deleteAdmin, getActivityLog));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

describe('GET /api/admins', () => {
  it('returns 200 with array of admins', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/admins');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(3);
  });
});

describe('POST /api/admins', () => {
  it('returns 201 with new admin', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/admins')
      .send({ name: 'Test Admin', email: 'test@ipnext.com.ar', role: 'viewer', status: 'active' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.name).toBe('Test Admin');
    expect(res.body.email).toBe('test@ipnext.com.ar');
    expect(res.body.role).toBe('viewer');
  });
});

describe('PUT /api/admins/:id', () => {
  it('returns 200 with updated admin', async () => {
    const app = buildApp();
    const res = await request(app)
      .put('/api/admins/1')
      .send({ role: 'admin' });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('1');
    expect(res.body.role).toBe('admin');
  });
});

describe('DELETE /api/admins/:id', () => {
  it('returns 204 on successful delete', async () => {
    const app = buildApp();
    const res = await request(app).delete('/api/admins/3');

    expect(res.status).toBe(204);
  });
});

describe('GET /api/admins/activity-log', () => {
  it('returns 200 with activity log array of 12 entries', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/admins/activity-log');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(12);
  });

  it('filters by category query param', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/admins/activity-log?category=auth');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.every((l: { category: string }) => l.category === 'auth')).toBe(true);
  });
});
