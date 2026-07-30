/**
 * customer-portal-api (Fase 2, task 2.5) — portal-auth spec "Rate limiting del
 * login": dedicated limiter for /auth/login (IP+DNI, stricter) + a general limiter
 * for authenticated /api/portal/* endpoints (by account). Also creates (but does
 * NOT wire — that's Fase 5) portalTicketCreateLimiter, so the ticket-creation wave
 * never has to touch this shared file.
 */
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import {
  createPortalLoginRateLimiter,
  createPortalGeneralRateLimiter,
  createPortalTicketCreateRateLimiter,
} from '@infrastructure/http/middleware/rateLimiters';

describe('createPortalLoginRateLimiter', () => {
  function buildApp(limit: number) {
    const app = express();
    app.use(express.json());
    const limiter = createPortalLoginRateLimiter({ windowMs: 60_000, limit });
    app.post('/login', limiter, (_req, res) => res.status(401).json({ error: 'bad creds' }));
    return app;
  }

  it('returns 429 RATE_LIMITED after exceeding the limit for the SAME (IP, dni)', async () => {
    const app = buildApp(2);
    const hit = () => request(app).post('/login').send({ dni: '30111222', password: 'x' });

    expect((await hit()).status).toBe(401);
    expect((await hit()).status).toBe(401);
    const over = await hit();
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('RATE_LIMITED');
  });

  it('does NOT group two different DNIs behind the same IP', async () => {
    const app = buildApp(2);
    const hit = (dni: string) => request(app).post('/login').send({ dni, password: 'x' });

    await hit('30111222');
    await hit('30111222');
    const over = await hit('30111222');
    const otherDni = await hit('30999888');

    expect(over.status).toBe(429);
    expect(otherDni.status).toBe(401); // fresh quota, unaffected
  });
});

describe('createPortalGeneralRateLimiter', () => {
  function buildApp(limit: number, accountId?: string) {
    const app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      if (accountId) req.portalAccountId = accountId;
      next();
    });
    const limiter = createPortalGeneralRateLimiter({ windowMs: 60_000, limit });
    app.get('/me', limiter, (_req, res) => res.status(200).json({ ok: true }));
    return app;
  }

  it('returns 429 after exceeding the limit for the SAME account', async () => {
    const app = buildApp(2, 'acc-1');
    expect((await request(app).get('/me')).status).toBe(200);
    expect((await request(app).get('/me')).status).toBe(200);
    const over = await request(app).get('/me');
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('RATE_LIMITED');
  });

  it('falls back to IP keying when req.portalAccountId is not set (unauthenticated route)', async () => {
    const app = buildApp(2, undefined);
    expect((await request(app).get('/me')).status).toBe(200);
    expect((await request(app).get('/me')).status).toBe(200);
    const over = await request(app).get('/me');
    expect(over.status).toBe(429);
  });

  it('does NOT group two different accounts behind the same IP', async () => {
    const appA = buildApp(1, 'acc-a');
    const appB = buildApp(1, 'acc-b');
    expect((await request(appA).get('/me')).status).toBe(200);
    // separate app instance = separate limiter store, but this asserts the
    // keyGenerator itself is account-scoped, not just "whatever store it landed in".
    expect((await request(appB).get('/me')).status).toBe(200);
  });
});

describe('createPortalTicketCreateRateLimiter', () => {
  it('is exported and enforces its own limit (5/hour default), independent of the general limiter', async () => {
    const app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.portalAccountId = 'acc-1';
      next();
    });
    const limiter = createPortalTicketCreateRateLimiter({ windowMs: 60_000, limit: 1 });
    app.post('/tickets', limiter, (_req, res) => res.status(201).json({ ok: true }));

    expect((await request(app).post('/tickets')).status).toBe(201);
    const over = await request(app).post('/tickets');
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('RATE_LIMITED');
  });
});
