import request from 'supertest';
import express, { Router, Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { profileRoutes } from '../infrastructure/http/routes/profile.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  const profileRouter = Router();
  profileRoutes(profileRouter);
  app.use('/api', profileRouter);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

function withAuth(req: request.Test) {
  return req.set('Cookie', 'auth_token=mock-token');
}

describe('GET /api/profile', () => {
  it('returns profile data', async () => {
    const app = buildApp();
    const res = await withAuth(request(app).get('/api/profile'));

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Admin Principal');
    expect(res.body.email).toBe('admin@ipnext.com.ar');
    expect(res.body.role).toBe('Superadministrador');
    expect(res.body.twoFactorEnabled).toBe(false);
  });

  it('returns 401 without auth cookie', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/profile');
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/profile', () => {
  it('updates name and returns updated profile', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).patch('/api/profile').send({ name: 'Nuevo Nombre' })
    );

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Nuevo Nombre');
  });

  it('returns 401 without auth cookie', async () => {
    const app = buildApp();
    const res = await request(app).patch('/api/profile').send({ name: 'Test' });
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/profile/password', () => {
  it('succeeds with correct current password', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).patch('/api/profile/password').send({
        currentPassword: 'admin123',
        newPassword: 'newpassword456',
      })
    );

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Contraseña actualizada');
  });

  it('returns 401 with wrong current password', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).patch('/api/profile/password').send({
        currentPassword: 'wrongpassword',
        newPassword: 'newpassword456',
      })
    );

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Contraseña actual incorrecta');
  });

  it('returns 400 when currentPassword is missing', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).patch('/api/profile/password').send({
        newPassword: 'newpassword456',
      })
    );

    expect(res.status).toBe(400);
  });

  it('returns 400 when newPassword is missing', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).patch('/api/profile/password').send({
        currentPassword: 'admin123',
      })
    );

    expect(res.status).toBe(400);
  });

  it('returns 401 without auth cookie', async () => {
    const app = buildApp();
    const res = await request(app)
      .patch('/api/profile/password')
      .send({ currentPassword: 'admin123', newPassword: 'new' });
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/profile/2fa', () => {
  it('toggles twoFactorEnabled to true', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).patch('/api/profile/2fa').send({ enabled: true })
    );

    expect(res.status).toBe(200);
    expect(res.body.twoFactorEnabled).toBe(true);
  });

  it('toggles twoFactorEnabled to false', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).patch('/api/profile/2fa').send({ enabled: false })
    );

    expect(res.status).toBe(200);
    expect(res.body.twoFactorEnabled).toBe(false);
  });

  it('returns 401 without auth cookie', async () => {
    const app = buildApp();
    const res = await request(app).patch('/api/profile/2fa').send({ enabled: true });
    expect(res.status).toBe(401);
  });
});
