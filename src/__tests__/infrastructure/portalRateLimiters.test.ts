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
  createPortalLoginIpRateLimiter,
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

  it('H3c (fix wave): el dni se normaliza (trim) y se TRUNCA a 32 chars en la key — un body gigante no infla la memoria del store', async () => {
    const app = buildApp(2);
    const base = 'A'.repeat(32);
    const hit = (dni: string) => request(app).post('/login').send({ dni, password: 'x' });

    // Tres DNIs "distintos" que comparten los primeros 32 chars: con la key
    // truncada caen en el MISMO bucket → el tercero da 429. Sin truncation
    // serían tres keys distintas (cada una del tamaño del body del atacante).
    await hit(`${base}X${'F'.repeat(50_000)}`);
    await hit(`${base}Y`);
    const over = await hit(`${base}Z`);
    expect(over.status).toBe(429);

    // Y el trim: el mismo dni con espacios alrededor comparte bucket con el original.
    await hit('  30111222  ');
    await hit('30111222');
    const trimmedOver = await hit(' 30111222 ');
    expect(trimmedOver.status).toBe(429);
  });
});

describe('createPortalLoginIpRateLimiter (H3b — techo por IP sola)', () => {
  it('429 al agotar el cupo por IP aunque CADA request use un DNI distinto (corta el barrido de enumeración)', async () => {
    const app = express();
    app.use(express.json());
    const limiter = createPortalLoginIpRateLimiter({ windowMs: 60_000, limit: 3 });
    app.post('/login', limiter, (_req, res) => res.status(401).json({ error: 'bad creds' }));

    expect((await request(app).post('/login').send({ dni: '10000001', password: 'x' })).status).toBe(401);
    expect((await request(app).post('/login').send({ dni: '10000002', password: 'x' })).status).toBe(401);
    expect((await request(app).post('/login').send({ dni: '10000003', password: 'x' })).status).toBe(401);
    const over = await request(app).post('/login').send({ dni: '10000004', password: 'x' });
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('RATE_LIMITED');
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

  it('does NOT group two different accounts behind the same IP (M4: UNA app, UN store — dos cuentas)', async () => {
    // M4 (fix wave): la versión anterior usaba DOS apps => DOS stores de
    // limiter — pasaba aunque el keyGenerator agrupara por IP (tautológico).
    // Acá el MISMO store atiende a las dos cuentas: si la key no fuera por
    // cuenta, B heredaría el 429 de A.
    const app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const account = req.header('x-test-account');
      if (account) req.portalAccountId = account;
      next();
    });
    const limiter = createPortalGeneralRateLimiter({ windowMs: 60_000, limit: 2 });
    app.get('/me', limiter, (_req, res) => res.status(200).json({ ok: true }));

    const hit = (account: string) => request(app).get('/me').set('x-test-account', account);

    // A agota su cuota (misma IP para todos los requests de supertest).
    expect((await hit('acc-a')).status).toBe(200);
    expect((await hit('acc-a')).status).toBe(200);
    expect((await hit('acc-a')).status).toBe(429);

    // B, detrás de la MISMA IP y el MISMO store, sigue con cuota fresca.
    expect((await hit('acc-b')).status).toBe(200);
    expect((await hit('acc-b')).status).toBe(200);
    // ... y B también topa con SU propia cuota (el limiter sí opera sobre B).
    expect((await hit('acc-b')).status).toBe(429);
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
