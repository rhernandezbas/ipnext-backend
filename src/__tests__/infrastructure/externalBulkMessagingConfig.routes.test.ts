/**
 * external-bulk-messaging (task 4.4, D7.c, CONFIG-1..3) — supertest sobre
 * `/api/messaging/config/external-bulk`, molde EXACTO `taskStageConfig.routes.test.ts`.
 * Respuesta FLAT `{maxPerRequest, maxPerDay, updatedAt}`, SIN envelope `{data}`
 * (D12) — verificado explícitamente (contrato acordado con el FE).
 */
import request from 'supertest';
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import { createExternalBulkMessagingConfigRouter } from '@infrastructure/http/routes/externalBulkMessagingConfig.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { InMemoryExternalBulkMessagingConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryExternalBulkMessagingConfigRepository';
import { GetExternalBulkConfig } from '@application/use-cases/messaging/GetExternalBulkConfig';
import { SetExternalBulkConfig } from '@application/use-cases/messaging/SetExternalBulkConfig';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';

const NOW = new Date('2026-09-02T12:00:00.000Z');

class FakeAuthProvider implements AuthProvider {
  async login() {
    return {
      user: { id: 'admin-1', username: 'test', email: 'test@test.com', role: 'admin' as const },
      cookieValue: 'fake',
      cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' },
    };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(_token: string): Promise<User> {
    return { id: 'admin-1', username: 'test', email: 'test@test.com', role: 'admin' };
  }
}

const grant: RequestHandler = (_req, _res, next) => next();
const deny: RequestHandler = (_req: Request, res: Response, _next: NextFunction) => {
  res.status(403).json({ error: 'FORBIDDEN', code: 'PERMISSION_DENIED' });
};

function buildApp(opts?: { read?: RequestHandler; manage?: RequestHandler }) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const configRepo = new InMemoryExternalBulkMessagingConfigRepository({ now: () => NOW });

  app.use(
    '/api/messaging/config/external-bulk',
    createExternalBulkMessagingConfigRouter(
      new FakeAuthProvider(),
      undefined,
      { read: opts?.read ?? grant, manage: opts?.manage ?? grant },
      new GetExternalBulkConfig(configRepo),
      new SetExternalBulkConfig(configRepo),
    ),
  );
  app.use(errorHandler);

  return { app, configRepo };
}

const AUTH_COOKIE = 'auth_token=fake';

describe('GET /api/messaging/config/external-bulk (CONFIG-1/CONFIG-2)', () => {
  it('200 con los defaults 500/2000 sin fila previa', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/messaging/config/external-bulk').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ maxPerRequest: 500, maxPerDay: 2000, updatedAt: NOW.toISOString() });
  });

  it('respuesta FLAT — sin envelope {data} (D12, contrato con el FE)', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/messaging/config/external-bulk').set('Cookie', AUTH_COOKIE);
    expect(res.body.data).toBeUndefined();
    expect(res.body.maxPerRequest).toBe(500);
  });

  it('403 sin messaging:read', async () => {
    const { app } = buildApp({ read: deny });
    const res = await request(app).get('/api/messaging/config/external-bulk').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/messaging/config/external-bulk (CONFIG-2/CONFIG-3)', () => {
  it('200 con un update válido — respuesta FLAT y persistida', async () => {
    const { app, configRepo } = buildApp();
    const res = await request(app)
      .put('/api/messaging/config/external-bulk')
      .set('Cookie', AUTH_COOKIE)
      .send({ maxPerRequest: 300, maxPerDay: 1500 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ maxPerRequest: 300, maxPerDay: 1500, updatedAt: NOW.toISOString() });
    expect((await configRepo.get()).maxPerRequest).toBe(300);
  });

  it('400 VALIDATION_ERROR cuando maxPerRequest > maxPerDay; la config NO cambia', async () => {
    const { app, configRepo } = buildApp();
    const res = await request(app)
      .put('/api/messaging/config/external-bulk')
      .set('Cookie', AUTH_COOKIE)
      .send({ maxPerRequest: 3000, maxPerDay: 2000 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect((await configRepo.get()).maxPerRequest).toBe(500); // default intacto
  });

  it('400 VALIDATION_ERROR cuando un valor no es positivo', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .put('/api/messaging/config/external-bulk')
      .set('Cookie', AUTH_COOKIE)
      .send({ maxPerRequest: 0, maxPerDay: 2000 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('403 con messaging:read pero SIN messaging:manage; la config no cambia', async () => {
    const { app, configRepo } = buildApp({ manage: deny });
    const res = await request(app)
      .put('/api/messaging/config/external-bulk')
      .set('Cookie', AUTH_COOKIE)
      .send({ maxPerRequest: 300, maxPerDay: 1500 });
    expect(res.status).toBe(403);
    expect((await configRepo.get()).maxPerRequest).toBe(500);
  });
});
