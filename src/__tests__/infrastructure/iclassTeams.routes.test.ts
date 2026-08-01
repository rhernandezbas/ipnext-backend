/**
 * Route tests for /api/admin/iclass/teams routes (R10-R11 from spec).
 * Uses in-memory repos. Exercises the real errorHandler.
 *
 * R10: GET  /teams → 200 { items } (gate: iclass.read) / 403 without
 * R11: POST /teams/sync → 200 { synced, created, ... } (gate: iclass.manage) / 503 IClass down
 */
import request from 'supertest';
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import { InMemoryIClassTeamRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassTeamRepository';
import { InMemoryIClassClient } from '@infrastructure/adapters/in-memory/InMemoryIClassClient';
import { SyncIClassTeams } from '@application/use-cases/SyncIClassTeams';
import { ListIClassTeams } from '@application/use-cases/ListIClassTeams';
import { createIClassTeamsRouter } from '@infrastructure/http/routes/iclassTeams.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { User } from '@domain/entities/auth';
import { AuthProvider } from '@domain/ports/AuthProvider';

class FakeAuthProvider implements AuthProvider {
  async login() {
    return {
      user: { id: 'a', username: 'u', email: 'e@e.com', role: 'admin' as const },
      cookieValue: 'fake',
      cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' },
    };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(_t: string): Promise<User> {
    return { id: 'a', username: 'u', email: 'e@e.com', role: 'admin' };
  }
}

const ALLOW: RequestHandler = (_req, _res, next) => next();
const DENY: RequestHandler = (_req: Request, res: Response, _next: NextFunction): void => {
  res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
};

function buildApp(opts: {
  iclassFails?: boolean;
  requireRead?: RequestHandler;
  requireManage?: RequestHandler;
} = {}) {
  const teamRepo = new InMemoryIClassTeamRepository();
  const iclass = new InMemoryIClassClient();
  if (opts.iclassFails) iclass.failureMode = 'unavailable';

  const syncUC = new SyncIClassTeams(iclass, teamRepo);
  const listUC = new ListIClassTeams(teamRepo);

  const requireRead = opts.requireRead ?? ALLOW;
  const requireManage = opts.requireManage ?? ALLOW;

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/admin/iclass',
    createIClassTeamsRouter(
      syncUC,
      listUC,
      new FakeAuthProvider(),
      undefined,
      requireRead,
      requireManage,
    ),
  );
  app.use(errorHandler);

  return { app, teamRepo, iclass };
}

// ─── R10: GET /api/admin/iclass/teams ────────────────────────────────────────

describe('R10: GET /api/admin/iclass/teams', () => {
  it('R10a: 200 with team items when catalog has entries', async () => {
    const { app, teamRepo } = buildApp();
    await teamRepo.upsertByLogin({ login: 'TEAM-A', name: 'Cuadrilla A', thirdPartyCode: 'TP-1', active: true, selectable: true });
    await teamRepo.upsertByLogin({ login: 'TEAM-B', name: 'Cuadrilla B', thirdPartyCode: null, active: true, selectable: true });

    const res = await request(app)
      .get('/api/admin/iclass/teams')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items).toHaveLength(2);

    const itemA = res.body.items.find((i: { login: string }) => i.login === 'TEAM-A');
    expect(itemA).toBeDefined();
    expect(itemA.name).toBe('Cuadrilla A');
    expect(itemA.thirdPartyCode).toBe('TP-1');
    expect(itemA.active).toBe(true);
    expect(itemA.selectable).toBe(true);
    expect(typeof itemA.lastSyncedAt).toBe('string');
  });

  it('R10b: 200 with empty items when catalog is empty', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .get('/api/admin/iclass/teams')
      .set('Cookie', 'auth_token=fake');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('R10c: 403 when user lacks iclass.read permission', async () => {
    const { app } = buildApp({ requireRead: DENY });
    const res = await request(app)
      .get('/api/admin/iclass/teams')
      .set('Cookie', 'auth_token=fake');
    expect(res.status).toBe(403);
  });
});

// ─── R11: POST /api/admin/iclass/teams/sync ──────────────────────────────────

describe('R11: POST /api/admin/iclass/teams/sync', () => {
  it('R11a: 200 with sync counts when IClass returns teams', async () => {
    const { app, iclass } = buildApp();
    iclass.teams = [
      { login: 'TEAM-A', name: 'Cuadrilla A', thirdPartyCode: 'TP-1' },
      { login: 'TEAM-B', name: 'Cuadrilla B', thirdPartyCode: null },
    ];

    const res = await request(app)
      .post('/api/admin/iclass/teams/sync')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(2);
    expect(res.body.created).toBe(2);
    expect(res.body.updated).toBe(0);
    expect(res.body.reactivated).toBe(0);
    expect(res.body.deactivated).toBe(0);
  });

  it('R11b: 502 when IClass is unavailable during sync', async () => {
    const { app } = buildApp({ iclassFails: true });
    const res = await request(app)
      .post('/api/admin/iclass/teams/sync')
      .set('Cookie', 'auth_token=fake');
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('ICLASS_UNAVAILABLE');
  });

  it('R11c: 403 when user lacks iclass.manage permission', async () => {
    const { app } = buildApp({ requireManage: DENY });
    const res = await request(app)
      .post('/api/admin/iclass/teams/sync')
      .set('Cookie', 'auth_token=fake');
    expect(res.status).toBe(403);
  });
});
