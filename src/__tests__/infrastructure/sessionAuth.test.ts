/**
 * SDD #5 Phase 2 — stateful auth: the middleware validates the session behind the JWT.
 */
import express, { Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { createAuthMiddleware } from '@infrastructure/http/middleware/authMiddleware';
import { InMemorySessionRepository } from '@infrastructure/adapters/in-memory/InMemorySessionRepository';
import { hashToken } from '@infrastructure/auth/sessionToken';
import { AuthenticationError } from '@domain/errors';
import type { AuthProvider } from '@domain/ports/AuthProvider';

function fakeAuthProvider(): AuthProvider {
  return {
    login: jest.fn(),
    logout: jest.fn(),
    getSession: async (token: string) => {
      if (token === 'invalid') throw new AuthenticationError('bad');
      return { id: 'u1', username: 'ana', email: 'a@x' };
    },
  } as unknown as AuthProvider;
}

function buildApp(sessionRepo: InMemorySessionRepository) {
  const app = express();
  app.use(cookieParser());
  app.use(createAuthMiddleware(fakeAuthProvider(), sessionRepo));
  app.get('/protected', (_req: Request, res: Response) => { res.json({ ok: true }); });
  return app;
}

const withToken = (app: express.Application, token: string) =>
  request(app).get('/protected').set('Cookie', `auth_token=${token}`);

describe('stateful auth middleware', () => {
  it('allows a request whose token maps to an active session', async () => {
    const repo = new InMemorySessionRepository();
    repo.seed({ rbacUserId: 'u1', actorLogin: 'ana', tokenHash: hashToken('tok-active') });
    const res = await withToken(buildApp(repo), 'tok-active');
    expect(res.status).toBe(200);
  });

  it('rejects (401) a token whose session was revoked', async () => {
    const repo = new InMemorySessionRepository();
    const s = repo.seed({ rbacUserId: 'u1', actorLogin: 'ana', tokenHash: hashToken('tok-revoked') });
    await repo.revoke(s.id);
    const res = await withToken(buildApp(repo), 'tok-revoked');
    expect(res.status).toBe(401);
  });

  it('rejects (401) a token whose session expired by the absolute 8h cap', async () => {
    const repo = new InMemorySessionRepository();
    const now = Date.now();
    repo.seed({
      rbacUserId: 'u1', actorLogin: 'ana', tokenHash: hashToken('tok-expired'),
      loginAt: new Date(now - 9 * 60 * 60 * 1000).toISOString(),
      lastSeenAt: new Date(now - 60 * 1000).toISOString(), // recently seen, but absolute cap hit
      expiresAt: new Date(now - 60 * 60 * 1000).toISOString(),
    });
    const res = await withToken(buildApp(repo), 'tok-expired');
    expect(res.status).toBe(401);
  });

  it('rejects (401) a token whose session is idle past the 1h inactivity window', async () => {
    const repo = new InMemorySessionRepository();
    const now = Date.now();
    repo.seed({
      rbacUserId: 'u1', actorLogin: 'ana', tokenHash: hashToken('tok-idle'),
      loginAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      lastSeenAt: new Date(now - 61 * 60 * 1000).toISOString(), // 61 min idle
      expiresAt: new Date(now + 6 * 60 * 60 * 1000).toISOString(),
    });
    const res = await withToken(buildApp(repo), 'tok-idle');
    expect(res.status).toBe(401);
  });

  it('rejects (401) a valid JWT with no session record', async () => {
    const repo = new InMemorySessionRepository();
    const res = await withToken(buildApp(repo), 'tok-orphan');
    expect(res.status).toBe(401);
  });

  it('rejects (401) an invalid JWT before any session lookup', async () => {
    const repo = new InMemorySessionRepository();
    const res = await withToken(buildApp(repo), 'invalid');
    expect(res.status).toBe(401);
  });

  it('does NOT touch lastSeenAt within the 5-min throttle window', async () => {
    const repo = new InMemorySessionRepository();
    repo.seed({ rbacUserId: 'u1', actorLogin: 'ana', tokenHash: hashToken('tok-fresh') }); // lastSeenAt = now
    const touch = jest.spyOn(repo, 'touch');
    await withToken(buildApp(repo), 'tok-fresh');
    await new Promise(r => setImmediate(r));
    expect(touch).not.toHaveBeenCalled();
  });

  it('touches lastSeenAt when it is older than the throttle window', async () => {
    const repo = new InMemorySessionRepository();
    repo.seed({
      rbacUserId: 'u1', actorLogin: 'ana', tokenHash: hashToken('tok-stale'),
      // older than the 5-min touch throttle but within the 1h inactivity window
      // (still alive) so the request passes and lastSeenAt gets touched.
      lastSeenAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    const touch = jest.spyOn(repo, 'touch');
    await withToken(buildApp(repo), 'tok-stale');
    await new Promise(r => setImmediate(r));
    expect(touch).toHaveBeenCalled();
  });
});
