/**
 * twilio-credit-guard (task 3.6, D5.c, RATES-1..3) — supertest sobre
 * `/api/messaging/config/rates`, molde EXACTO
 * `externalBulkMessagingConfig.routes.test.ts`. Respuesta FLAT, sin envelope
 * `{data}`. `GET /balance` usa `GetMessagingCredit` REAL + adapters in-memory
 * (JAMÁS se mockea el use case).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import { createMessagingRatesConfigRouter } from '@infrastructure/http/routes/messaging-rates-config.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { InMemoryMessagingRatesConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryMessagingRatesConfigRepository';
import { InMemoryCreditBalancePort } from '@infrastructure/adapters/in-memory/InMemoryCreditBalancePort';
import { GetMessagingRatesConfig } from '@application/use-cases/messaging/GetMessagingRatesConfig';
import { SetMessagingRatesConfig } from '@application/use-cases/messaging/SetMessagingRatesConfig';
import { GetMessagingCredit } from '@application/use-cases/messaging/GetMessagingCredit';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';

const NOW = new Date('2026-09-03T12:00:00.000Z');

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

function buildApp(opts?: {
  read?: RequestHandler;
  manage?: RequestHandler;
  creditAmount?: string;
  creditCurrency?: string;
  creditFails?: boolean;
}) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const ratesRepo = new InMemoryMessagingRatesConfigRepository({ now: () => NOW });
  const creditPort = new InMemoryCreditBalancePort({
    amount: opts?.creditAmount ?? '17.8940',
    currency: opts?.creditCurrency ?? 'USD',
    fetchedAt: NOW,
    failNext: opts?.creditFails ?? false,
  });

  app.use(
    '/api/messaging/config/rates',
    createMessagingRatesConfigRouter(
      new FakeAuthProvider(),
      undefined,
      { read: opts?.read ?? grant, manage: opts?.manage ?? grant },
      new GetMessagingRatesConfig(ratesRepo),
      new SetMessagingRatesConfig(ratesRepo),
      new GetMessagingCredit(creditPort, ratesRepo),
    ),
  );
  app.use(errorHandler);

  return { app, ratesRepo, creditPort };
}

const AUTH_COOKIE = 'auth_token=fake';

describe('GET /api/messaging/config/rates (RATES-1)', () => {
  it('200 con los 5 defaults sin fila previa', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/messaging/config/rates').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      currency: 'USD',
      utilityRate: '0.0120',
      marketingRate: '0.0618',
      authenticationRate: '0.0220',
      providerFee: '0.0050',
      updatedAt: NOW.toISOString(),
    });
  });

  it('respuesta FLAT — sin envelope {data}', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/messaging/config/rates').set('Cookie', AUTH_COOKIE);
    expect(res.body.data).toBeUndefined();
    expect(res.body.currency).toBe('USD');
  });

  it('403 sin messaging:read', async () => {
    const { app } = buildApp({ read: deny });
    const res = await request(app).get('/api/messaging/config/rates').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/messaging/config/rates (RATES-2/RATES-3)', () => {
  it('200 con un update válido — respuesta FLAT y persistida', async () => {
    const { app, ratesRepo } = buildApp();
    const res = await request(app)
      .put('/api/messaging/config/rates')
      .set('Cookie', AUTH_COOKIE)
      .send({ currency: 'USD', utilityRate: '0.015', marketingRate: '0.07', authenticationRate: '0.025', providerFee: '0.006' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      currency: 'USD',
      utilityRate: '0.0150',
      marketingRate: '0.0700',
      authenticationRate: '0.0250',
      providerFee: '0.0060',
      updatedAt: NOW.toISOString(),
    });
    expect((await ratesRepo.get()).marketingRate).toBe('0.0700');
  });

  it('400 VALIDATION_ERROR con una tarifa negativa; la config NO cambia', async () => {
    const { app, ratesRepo } = buildApp();
    const res = await request(app)
      .put('/api/messaging/config/rates')
      .set('Cookie', AUTH_COOKIE)
      .send({ currency: 'USD', utilityRate: '-0.01', marketingRate: '0.0618', authenticationRate: '0.0220', providerFee: '0.0050' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect((await ratesRepo.get()).utilityRate).toBe('0.0120'); // default intacto
  });

  it('400 VALIDATION_ERROR con más de 4 decimales', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .put('/api/messaging/config/rates')
      .set('Cookie', AUTH_COOKIE)
      .send({ currency: 'USD', utilityRate: '0.0120', marketingRate: '0.06185', authenticationRate: '0.0220', providerFee: '0.0050' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('400 VALIDATION_ERROR con currency inválida (minúscula)', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .put('/api/messaging/config/rates')
      .set('Cookie', AUTH_COOKIE)
      .send({ currency: 'usd', utilityRate: '0.0120', marketingRate: '0.0618', authenticationRate: '0.0220', providerFee: '0.0050' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('400 VALIDATION_ERROR con currency de 4 letras', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .put('/api/messaging/config/rates')
      .set('Cookie', AUTH_COOKIE)
      .send({ currency: 'USDD', utilityRate: '0.0120', marketingRate: '0.0618', authenticationRate: '0.0220', providerFee: '0.0050' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('400 VALIDATION_ERROR cuando una tarifa llega como number (no string) — reintroduciría el float', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .put('/api/messaging/config/rates')
      .set('Cookie', AUTH_COOKIE)
      .send({ currency: 'USD', utilityRate: 0.012, marketingRate: '0.0618', authenticationRate: '0.0220', providerFee: '0.0050' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('403 con messaging:read pero SIN messaging:manage; la config no cambia', async () => {
    const { app, ratesRepo } = buildApp({ manage: deny });
    const res = await request(app)
      .put('/api/messaging/config/rates')
      .set('Cookie', AUTH_COOKIE)
      .send({ currency: 'USD', utilityRate: '0.015', marketingRate: '0.07', authenticationRate: '0.025', providerFee: '0.006' });
    expect(res.status).toBe(403);
    expect((await ratesRepo.get()).utilityRate).toBe('0.0120');
  });
});

describe('GET /api/messaging/config/rates/balance (D5.c)', () => {
  it('200 con {available, currency, fetchedAt, cached} — SIN el bloque rates', async () => {
    const { app } = buildApp({ creditAmount: '17.8940', creditCurrency: 'USD' });
    const res = await request(app).get('/api/messaging/config/rates/balance').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: '17.8940', currency: 'USD', fetchedAt: NOW.toISOString(), cached: false });
    expect(res.body.rates).toBeUndefined();
  });

  it('503 CREDIT_UNAVAILABLE cuando el balance no se puede leer', async () => {
    const { app } = buildApp({ creditFails: true });
    const res = await request(app).get('/api/messaging/config/rates/balance').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('CREDIT_UNAVAILABLE');
  });

  it('403 sin messaging:read', async () => {
    const { app } = buildApp({ read: deny });
    const res = await request(app).get('/api/messaging/config/rates/balance').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(403);
  });
});

/**
 * fix wave F1 (R2 #8) — ASIMETRÍA DELIBERADA del kill-switch (CG-AUTH-2).
 * `GET /credit` del router EXTERNO está detrás de `messaging-external-bulk-enabled`
 * (403 con el flag OFF). Este router ADMIN NO lo está, y es correcto: el
 * kill-switch apaga el ENVÍO M2M, no la capacidad del operador de mirar cuánto
 * saldo hay — que es lo primero que uno quiere ver cuando apagó los envíos.
 *
 * Se pinea ESTRUCTURALMENTE: el router no recibe ni consulta un
 * `FeatureFlagRepository`. Si alguien "unificara" el criterio metiéndole el
 * kill-switch, este test lo frena y obliga a discutirlo contra CG-AUTH-2.
 */
describe('GET /balance — NO está detrás del kill-switch (fix wave F1, R2 #8 / CG-AUTH-2)', () => {
  it('el router admin no depende de ningún FeatureFlagRepository (scan de fuente)', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'http', 'routes', 'messaging-rates-config.routes.ts'),
      'utf8',
    );
    const code = src
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');

    expect(code).not.toContain('FeatureFlagRepository');
    expect(code).not.toContain('messaging-external-bulk-enabled');
    expect(code).not.toContain('FeatureExternalBulkDisabledError');
  });

  it('el saldo se sirve igual sin ningún flag en juego (200, gate solo por messaging:read)', async () => {
    const { app } = buildApp({ creditAmount: '17.8940' });
    const res = await request(app).get('/api/messaging/config/rates/balance').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe('17.8940');
  });
});
