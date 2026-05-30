/**
 * SDD #5 Phase 2 — login creates a session; logout revokes it.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { createAuthRouter } from '@infrastructure/http/routes/auth.routes';
import { InMemorySessionRepository } from '@infrastructure/adapters/in-memory/InMemorySessionRepository';
import { hashToken } from '@infrastructure/auth/sessionToken';

const JWT = 'jwt-abc';

function fakeAuthProvider() {
  return {
    login: async () => ({
      user: { id: 'u1', username: 'ana', email: 'a@x' },
      cookieValue: JWT,
      cookieOptions: { httpOnly: true, path: '/' },
    }),
    logout: () => ({ cookieOptions: { httpOnly: true, maxAge: 0, path: '/' } }),
    getSession: async () => ({ id: 'u1', username: 'ana', email: 'a@x' }),
  };
}

function buildApp(sessionRepo: InMemorySessionRepository) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  const stub = {} as never;
  app.use(
    '/api/auth',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createAuthRouter(fakeAuthProvider() as any, stub, stub, stub, sessionRepo),
  );
  return app;
}

describe('auth session lifecycle', () => {
  it('login creates an active session for the issued token', async () => {
    const repo = new InMemorySessionRepository();
    const app = buildApp(repo);

    const res = await request(app).post('/api/auth/login').send({ username: 'ana', password: 'x' });
    expect(res.status).toBe(200);

    const session = await repo.findByTokenHash(hashToken(JWT));
    expect(session).not.toBeNull();
    expect(session!.rbacUserId).toBe('u1');
    expect(session!.actorLogin).toBe('ana');
  });

  it('logout revokes the current session', async () => {
    const repo = new InMemorySessionRepository();
    const app = buildApp(repo);

    await request(app).post('/api/auth/login').send({ username: 'ana', password: 'x' });
    expect(await repo.findByTokenHash(hashToken(JWT))).not.toBeNull();

    const res = await request(app).post('/api/auth/logout').set('Cookie', `auth_token=${JWT}`);
    expect(res.status).toBe(200);
    expect(await repo.findByTokenHash(hashToken(JWT))).toBeNull(); // revoked
  });
});
