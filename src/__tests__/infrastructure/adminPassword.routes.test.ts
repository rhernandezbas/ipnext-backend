/**
 * TDD — Feature A: set password when creating an administrator (route layer)
 * POST /api/admins with password → 201, passwordHash NOT in response.
 * POST /api/admins without password → 400.
 */
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

describe('POST /api/admins — password handling', () => {
  it('returns 201 and creates admin when password is provided', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/admins')
      .send({ name: 'New Admin', email: 'new@ipnext.com.ar', role: 'admin', status: 'active', password: 'secret123' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.name).toBe('New Admin');
    // passwordHash MUST NOT be exposed in the response
    expect(res.body.passwordHash).toBeUndefined();
  });

  it('returns 400 when password is missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/admins')
      .send({ name: 'No-pass Admin', email: 'nopass@ipnext.com.ar', role: 'viewer', status: 'active' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});
