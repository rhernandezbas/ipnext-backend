import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { InMemoryAdminRepository } from '../../infrastructure/adapters/in-memory/InMemoryAdminRepository';
import { ListAdmins } from '../../application/use-cases/ListAdmins';
import { GetAdmin } from '../../application/use-cases/GetAdmin';
import { CreateAdmin } from '../../application/use-cases/CreateAdmin';
import { UpdateAdmin } from '../../application/use-cases/UpdateAdmin';
import { DeleteAdmin } from '../../application/use-cases/DeleteAdmin';
import { GetAdminActivityLog } from '../../application/use-cases/GetAdminActivityLog';
import { Get2FAStatus } from '../../application/use-cases/Get2FAStatus';
import { Enable2FA } from '../../application/use-cases/Enable2FA';
import { Disable2FA } from '../../application/use-cases/Disable2FA';
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
  const get2FAStatus = new Get2FAStatus(repo);
  const enable2FA = new Enable2FA(repo);
  const disable2FA = new Disable2FA(repo);

  app.use(
    '/api/admins',
    createAdminRouter(
      listAdmins, getAdmin, createAdmin, updateAdmin, deleteAdmin, getActivityLog,
      get2FAStatus, enable2FA, disable2FA,
    ),
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

describe('GET /api/admins/:id/2fa', () => {
  it('returns enabled:false for new admin', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/admins/1/2fa');

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.method).toBeNull();
    expect(res.body.adminId).toBe('1');
  });
});

describe('POST /api/admins/:id/2fa/enable', () => {
  it('returns 200 with qrCode and backupCodes', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/admins/1/2fa/enable')
      .send({ method: 'totp' });

    expect(res.status).toBe(200);
    expect(res.body.qrCode).toBeTruthy();
    expect(res.body.qrCode).toMatch(/^data:image\/png;base64,/);
    expect(Array.isArray(res.body.backupCodes)).toBe(true);
    expect(res.body.backupCodes.length).toBeGreaterThan(0);
  });
});

describe('DELETE /api/admins/:id/2fa', () => {
  it('returns 200', async () => {
    const app = buildApp();
    const res = await request(app).delete('/api/admins/1/2fa');

    expect(res.status).toBe(200);
  });
});
