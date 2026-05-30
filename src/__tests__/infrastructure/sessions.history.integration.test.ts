/**
 * Integration tests for GET /api/admin/sessions/history (SDD sessions-history Phase 5).
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';

import { InMemorySessionRepository } from '@infrastructure/adapters/in-memory/InMemorySessionRepository';
import { ListActiveSessions } from '@application/use-cases/sessions/ListActiveSessions';
import { RevokeSession } from '@application/use-cases/sessions/RevokeSession';
import { RevokeAllSessionsForUser } from '@application/use-cases/sessions/RevokeAllSessionsForUser';
import { ListSessionHistory } from '@application/use-cases/sessions/ListSessionHistory';
import { createSessionsRouter } from '@infrastructure/http/routes/sessions.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';

function guard(ok: boolean) {
  return ok
    ? (_req: Request, _res: Response, next: NextFunction) => next()
    : (_req: Request, res: Response) => { res.status(401).json({ code: 'UNAUTHORIZED' }); };
}

function buildApp(opts: {
  revokedSessions?: Array<{ tokenHash: string; revokedAt: string }>;
  activeSessions?: Array<{ tokenHash: string }>;
  authenticated?: boolean;
} = {}) {
  const {
    revokedSessions = [],
    activeSessions = [],
    authenticated = true,
  } = opts;

  const repo = new InMemorySessionRepository();

  for (const s of activeSessions) {
    repo.seed({ tokenHash: s.tokenHash, revokedAt: null });
  }
  for (const s of revokedSessions) {
    repo.seed({ tokenHash: s.tokenHash, revokedAt: s.revokedAt });
  }

  const app = express();
  app.use(express.json());

  // Simulate auth middleware
  if (authenticated) {
    app.use((_req: Request, _res: Response, next: NextFunction) => next());
  } else {
    app.use((_req: Request, res: Response) => {
      res.status(401).json({ code: 'UNAUTHORIZED' });
    });
  }

  app.use(
    '/api/admin/sessions',
    createSessionsRouter(
      new ListActiveSessions(repo),
      new RevokeSession(repo),
      new RevokeAllSessionsForUser(repo),
      new ListSessionHistory(repo),
      guard(true),
      guard(true),
    ),
  );
  app.use(errorHandler);
  return { app, repo };
}

describe('GET /api/admin/sessions/history', () => {
  it('200 with revoked sessions, envelope {data, total, page, pageSize}', async () => {
    const { app } = buildApp({
      revokedSessions: [
        { tokenHash: 'r1', revokedAt: '2026-05-01T10:00:00.000Z' },
        { tokenHash: 'r2', revokedAt: '2026-05-10T10:00:00.000Z' },
        { tokenHash: 'r3', revokedAt: '2026-05-20T10:00:00.000Z' },
      ],
    });
    const res = await request(app).get('/api/admin/sessions/history?page=1&pageSize=20');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 3, page: 1, pageSize: 20 });
    expect(res.body.data).toHaveLength(3);
  });

  it('200 with empty data when no revoked sessions', async () => {
    const { app } = buildApp({ activeSessions: [{ tokenHash: 'active' }] });
    const res = await request(app).get('/api/admin/sessions/history?page=1&pageSize=20');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ data: [], total: 0, page: 1, pageSize: 20 });
  });

  it('pagination: page=2&pageSize=5 with 7 revoked → data.length===2, total:7', async () => {
    const revokedSessions = Array.from({ length: 7 }, (_, i) => ({
      tokenHash: `r${i}`,
      revokedAt: new Date(2026, 4, i + 1).toISOString(),
    }));
    const { app } = buildApp({ revokedSessions });
    const res = await request(app).get('/api/admin/sessions/history?page=2&pageSize=5');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(7);
  });

  it('400 when pageSize > 100', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/admin/sessions/history?pageSize=200');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('401 when unauthenticated', async () => {
    const { app } = buildApp({ authenticated: false });
    const res = await request(app).get('/api/admin/sessions/history');
    expect(res.status).toBe(401);
  });

  it('no item in data has tokenHash', async () => {
    const { app } = buildApp({
      revokedSessions: [{ tokenHash: 'secret', revokedAt: '2026-05-01T10:00:00.000Z' }],
    });
    const res = await request(app).get('/api/admin/sessions/history');
    expect(res.status).toBe(200);
    for (const item of res.body.data) {
      expect(item).not.toHaveProperty('tokenHash');
    }
  });

  it('non-regression: GET /api/admin/sessions returns only active sessions', async () => {
    const { app } = buildApp({
      activeSessions: [{ tokenHash: 'active-1' }, { tokenHash: 'active-2' }],
      revokedSessions: [{ tokenHash: 'revoked-1', revokedAt: '2026-05-01T10:00:00.000Z' }],
    });
    const res = await request(app).get('/api/admin/sessions');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    for (const item of res.body.items) {
      expect(item.revokedAt).toBeNull();
    }
  });
});
