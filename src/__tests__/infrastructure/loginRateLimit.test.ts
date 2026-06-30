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

  // login-ratelimit-nat fix: el limiter keyea por IP+username. Dos usuarios DISTINTOS
  // detrás de la MISMA IP (NAT de oficina) NO deben pisarse — el bug del incidente era
  // que el keyGenerator por-IP los agrupaba y el 429 caía sobre todos.
  it('no agrupa usuarios distintos detrás de la misma IP (keyea por IP+username)', async () => {
    const app = buildApp(); // limit: 2 por (IP+username)
    const hit = (username: string) =>
      request(app).post('/api/auth/login').send({ username, password: 'x' });

    await hit('ana');               // ana 1 → 401
    await hit('ana');               // ana 2 → 401
    const anaOver = await hit('ana'); // ana 3 → 429 (su propia cuota agotada)
    const beto1 = await hit('beto');  // beto 1, MISMA IP → debe ser 401, NO 429

    expect(anaOver.status).toBe(429);  // el usuario brute-forceado SÍ se limita
    expect(beto1.status).toBe(401);    // otro usuario en la misma IP NO se pisa (bug viejo → 429)
  });

  it('limita el brute-force contra UN usuario (mismo IP+username)', async () => {
    const app = buildApp(); // limit: 2
    const hit = () => request(app).post('/api/auth/login').send({ username: 'victima', password: 'x' });
    await hit();
    await hit();
    const over = await hit(); // 3er intento contra 'victima' → 429
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('RATE_LIMITED');
  });
});
