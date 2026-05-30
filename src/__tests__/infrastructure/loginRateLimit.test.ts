/**
 * SDD #6a Phase 2 — rate limit on POST /api/auth/login.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { createAuthRouter } from '@infrastructure/http/routes/auth.routes';
import { createLoginRateLimiter } from '@infrastructure/http/middleware/rateLimiters';
import { AuthenticationError } from '@domain/errors';

// authProvider whose login always fails — the limiter must count regardless of outcome.
function fakeAuthProvider() {
  return {
    login: async () => { throw new AuthenticationError('bad'); },
    logout: () => ({ cookieOptions: { maxAge: 0 } }),
    getSession: async () => ({ id: 'u1', username: 'a', email: 'a@x' }),
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  const stub = {} as never;
  const limiter = createLoginRateLimiter({ windowMs: 60_000, limit: 2 });
  app.use(
    '/api/auth',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createAuthRouter(fakeAuthProvider() as any, stub, stub, stub, undefined, limiter),
  );
  return app;
}

describe('POST /api/auth/login rate limit', () => {
  it('returns 429 RATE_LIMITED after exceeding the limit', async () => {
    const app = buildApp();
    const hit = () => request(app).post('/api/auth/login').send({ username: 'a', password: 'b' });

    const r1 = await hit(); // 1 — 401 invalid creds
    const r2 = await hit(); // 2 — 401
    const r3 = await hit(); // 3 — over limit → 429

    expect(r1.status).toBe(401);
    expect(r2.status).toBe(401);
    expect(r3.status).toBe(429);
    expect(r3.body.code).toBe('RATE_LIMITED');
  });
});
