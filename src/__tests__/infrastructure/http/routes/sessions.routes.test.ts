/**
 * sessions.routes.test.ts — GET /admin/sessions + revoke + revoke-all (SDD #5 Phase 3).
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';

import { InMemorySessionRepository } from '@infrastructure/adapters/in-memory/InMemorySessionRepository';
import { ListActiveSessions } from '@application/use-cases/sessions/ListActiveSessions';
import { RevokeSession } from '@application/use-cases/sessions/RevokeSession';
import { RevokeAllSessionsForUser } from '@application/use-cases/sessions/RevokeAllSessionsForUser';
import { createSessionsRouter } from '@infrastructure/http/routes/sessions.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';

function guard(ok: boolean) {
  return ok
    ? (_req: Request, _res: Response, next: NextFunction) => next()
    : (_req: Request, res: Response) => { res.status(403).json({ code: 'FORBIDDEN' }); };
}

function buildApp(opts: { view?: boolean; revoke?: boolean } = {}) {
  const { view = true, revoke = true } = opts;
  const app = express();
  app.use(express.json());
  const repo = new InMemorySessionRepository();
  repo.seed({ id: 's1', rbacUserId: 'u1', actorLogin: 'ana', tokenHash: 'h1', loginAt: '2026-05-10T10:00:00.000Z' });
  repo.seed({ id: 's2', rbacUserId: 'u1', actorLogin: 'ana', tokenHash: 'h2', loginAt: '2026-05-20T10:00:00.000Z' });
  repo.seed({ id: 's3', rbacUserId: 'u2', actorLogin: 'beto', tokenHash: 'h3', loginAt: '2026-05-25T10:00:00.000Z' });

  app.use(
    '/api/admin/sessions',
    createSessionsRouter(
      new ListActiveSessions(repo),
      new RevokeSession(repo),
      new RevokeAllSessionsForUser(repo),
      guard(view),
      guard(revoke),
    ),
  );
  app.use(errorHandler);
  return { app, repo };
}

describe('GET /api/admin/sessions', () => {
  it('returns active sessions (paginated, DTO without tokenHash)', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/admin/sessions?page=1&pageSize=50');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 3, page: 1, pageSize: 50 });
    expect(res.body.items).toHaveLength(3);
    expect(res.body.items[0]).not.toHaveProperty('tokenHash');
  });

  it('filters by rbacUserId', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/admin/sessions?rbacUserId=u1');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
  });

  it('403 without view_sessions', async () => {
    const { app } = buildApp({ view: false });
    expect((await request(app).get('/api/admin/sessions')).status).toBe(403);
  });
});

describe('POST /api/admin/sessions/:id/revoke', () => {
  it('revokes the session', async () => {
    const { app, repo } = buildApp();
    const res = await request(app).post('/api/admin/sessions/s1/revoke');
    expect([200, 204]).toContain(res.status);
    expect(await repo.findByTokenHash('h1')).toBeNull();
  });

  it('404 for an unknown session', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/admin/sessions/nope/revoke');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SESSION_NOT_FOUND');
  });

  it('403 without revoke_sessions', async () => {
    const { app } = buildApp({ revoke: false });
    expect((await request(app).post('/api/admin/sessions/s1/revoke')).status).toBe(403);
  });
});

describe('POST /api/admin/sessions/user/:userId/revoke-all', () => {
  it('revokes all active sessions of the user and returns the count', async () => {
    const { app, repo } = buildApp();
    const res = await request(app).post('/api/admin/sessions/user/u1/revoke-all');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ revoked: 2 });
    expect((await repo.listActive({ rbacUserId: 'u1' })).total).toBe(0);
  });

  it('403 without revoke_sessions', async () => {
    const { app } = buildApp({ revoke: false });
    expect((await request(app).post('/api/admin/sessions/user/u1/revoke-all')).status).toBe(403);
  });
});
