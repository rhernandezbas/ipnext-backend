/**
 * noc-alerts-hub — fix "el ingest de alertas se comía 429 al filo de 30/min".
 *
 * Medido en vivo (2026-07-26): el colector de fibra (VM 130) postea ~29 requests
 * de golpe cada 30 min (9 PON + 20 individuales) contra `POST /ingest/:source`,
 * que reusaba `createExternalWriteRateLimiter()` (30 req/60s por IP) — el limiter
 * pensado para el API externo de tickets, NO para ingesta máquina-a-máquina de
 * un colector propio ya autenticado por shared-secret. Un incidente de fibra
 * (muchas ONUs degradando a la vez) dispara un burst MUCHO mayor a 29 y el 429
 * empieza a tirar alertas reales justo cuando más importan.
 *
 * Fix: `createIngestRateLimiter()` — limiter DEDICADO para la ingesta, generoso
 * (default 600 req/60s) pero acotado (sigue siendo anti-abuso, no shaping de un
 * consumidor legítimo). `createExternalWriteRateLimiter()` NO se tocó — sigue en
 * 30/60s para `/api/external/v1` (tickets/news).
 *
 * Estos tests ejercen el MIDDLEWARE directo (app mínima), no el router completo
 * de alerts (ese ya tiene su propia integración en alerts.routes.test.ts F7) —
 * más rápido y aislado del resto del wiring (RBAC/auth/feature flags).
 */
import express from 'express';
import request from 'supertest';

import {
  createIngestRateLimiter,
  createExternalWriteRateLimiter,
} from '@infrastructure/http/middleware/rateLimiters';

function appWith(limiter: express.RequestHandler): express.Express {
  const app = express();
  app.post('/probe', limiter, (_req, res) => {
    res.status(201).json({ ok: true });
  });
  return app;
}

describe('createIngestRateLimiter (alerts ingest dedicated limiter)', () => {
  it('permite un burst de 100 requests seguidas sin ningún 429 (default generoso, > 30)', async () => {
    const app = appWith(createIngestRateLimiter());

    const statuses: number[] = [];
    for (let i = 0; i < 100; i++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).post('/probe');
      statuses.push(res.status);
    }

    expect(statuses.every((s) => s === 201)).toBe(true);
    expect(statuses).not.toContain(429);
  });

  it('sigue devolviendo 429 al superar el límite configurado (el 429 no desapareció, solo subió el techo)', async () => {
    const app = appWith(createIngestRateLimiter({ windowMs: 60_000, limit: 5 }));

    const send = () => request(app).post('/probe');
    const results = [];
    for (let i = 0; i < 6; i++) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await send());
    }

    const okCount = results.filter((r) => r.status === 201).length;
    const limitedCount = results.filter((r) => r.status === 429).length;

    expect(okCount).toBe(5);
    expect(limitedCount).toBe(1);
    expect(results[5]?.status).toBe(429);
    expect(results[5]?.body.code).toBe('RATE_LIMITED');
  });
});

describe('createExternalWriteRateLimiter (API externo — NO se tocó, sigue en 30/60s)', () => {
  it('default sigue siendo 30 requests/60s por IP: la 31 es 429', async () => {
    const app = appWith(createExternalWriteRateLimiter());

    const send = () => request(app).post('/probe');
    const results = [];
    for (let i = 0; i < 31; i++) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await send());
    }

    const okCount = results.filter((r) => r.status === 201).length;
    expect(okCount).toBe(30);
    expect(results[30]?.status).toBe(429);
  });
});
