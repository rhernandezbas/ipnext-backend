/**
 * portal-usage-metrics — cobertura de RUTA de "Mi consumo"
 * (`GET /api/portal/usage/:contractId`) sobre la app Express real + repos
 * in-memory (molde `portalEquipment.routes.test.ts`).
 *
 * Lo que agrega sobre los tests de use case: que el contrato wire llegue TAL
 * CUAL por HTTP (la app se construye contra esta forma), que el 404 anti-IDOR
 * sea indistinguible, y que el payload sea SERIALIZABLE — los bytes viajan como
 * `number`, no como BigInt (`JSON.stringify` de un BigInt tira TypeError y el
 * endpoint devolvería 500).
 */
import express from 'express';
import request from 'supertest';

import { createPortalRouter } from '@infrastructure/http/routes/portal.routes';
import { createPortalAuthMiddleware } from '@infrastructure/http/middleware/portalAuthMiddleware';
import { createPortalKillSwitchMiddleware } from '@infrastructure/http/middleware/portalKillSwitchMiddleware';
import { createPortalGeneralRateLimiter } from '@infrastructure/http/middleware/rateLimiters';

import { InMemoryPortalAccountRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalAccountRepository';
import { InMemoryPortalSessionRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalSessionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { InMemorySettingsRepository } from '@infrastructure/adapters/in-memory/InMemorySettingsRepository';
import { InMemoryUsageMetricsReader } from '@infrastructure/adapters/in-memory/InMemoryUsageMetricsReader';
import { JwtPortalTokenService } from '@infrastructure/adapters/jwt/JwtPortalTokenService';

import { PortalLogin } from '@application/use-cases/portal/PortalLogin';
import { GetPortalUsageMetrics } from '@application/use-cases/portal/GetPortalUsageMetrics';

import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import type { Contract } from '@domain/entities/customer';
import type { PppoeService } from '@domain/entities/pppoeService';

const TEST_SECRET = 'test-jwt-secret-32chars-minimum!';
const NOW = new Date('2026-08-05T14:00:00.000Z'); // 11:00 ART del 5/8/2026
const GB = 1_000_000_000;

function makeContract(id: string): Contract {
  return {
    id,
    code: null,
    type: 'internet',
    plan: '100 Mb',
    ip: '10.0.0.1',
    status: 'active',
    startDate: '2025-01-01T00:00:00.000Z',
    endDate: '',
    address: null,
    lat: null,
    lng: null,
    technology: null,
    name: null,
    vendedor: null,
    services: [],
  } as Contract;
}

function makePppoe(username: string, contractId: string): PppoeService {
  return {
    id: `pppoe-${username}`,
    username,
    password: 'secret',
    profile: 'IP-Air-100',
    remoteAddress: '100.64.28.10',
    status: 'enabled',
    nasId: 'nas-1',
    contractId,
    enforcedState: 'active',
    callerId: null,
    ipMode: 'fixed',
    ipTypePreference: 'cgnat',
    createdAt: '2025-01-01T00:00:00.000Z',
  } as PppoeService;
}

function buildStack(opts?: {
  contracts?: Record<string, Contract[]>;
  pppoe?: Record<string, PppoeService[]>;
}) {
  const accounts = new InMemoryPortalAccountRepository();
  const sessions = new InMemoryPortalSessionRepository();
  const hasher = new InMemoryPasswordHasher();
  const settingsRepo = new InMemorySettingsRepository();
  const tokenService = new JwtPortalTokenService(TEST_SECRET);

  const portalLogin = new PortalLogin(accounts, sessions, hasher, tokenService);
  const portalAuthMiddleware = createPortalAuthMiddleware(tokenService, accounts);
  const killSwitch = createPortalKillSwitchMiddleware(settingsRepo, 30_000);
  const generalRateLimiter = createPortalGeneralRateLimiter({ windowMs: 60_000, limit: 1000 });

  const contracts = opts?.contracts ?? { 'client-a': [makeContract('c1')] };
  const pppoeByContract = opts?.pppoe ?? { c1: [makePppoe('juan.perez', 'c1')] };

  const customers: Pick<CustomerRepository, 'listContracts'> = {
    listContracts: async (clientId: string) => contracts[clientId] ?? [],
  };
  const pppoe: Pick<PppoeServiceRepository, 'findByContract'> = {
    findByContract: async (contractId: string) => pppoeByContract[contractId] ?? [],
  };

  const reader = new InMemoryUsageMetricsReader();
  const getPortalUsageMetrics = new GetPortalUsageMetrics(customers, pppoe, reader, () => NOW);

  const app = express();
  app.use(express.json());
  app.use(
    '/api/portal',
    createPortalRouter({
      portalLogin,
      refreshPortalSession: { execute: async () => { throw new Error('not used'); } } as never,
      logoutPortal: { execute: async () => {} } as never,
      changePortalPassword: { execute: async () => {} } as never,
      portalAuthMiddleware,
      killSwitch,
      generalRateLimiter,
      getPortalUsageMetrics,
    }),
  );

  return { app, accounts, hasher, reader };
}

async function loginAs(
  app: express.Express,
  accounts: InMemoryPortalAccountRepository,
  hasher: InMemoryPasswordHasher,
  clientId: string,
): Promise<string> {
  const dni = `dni-${clientId}`;
  await accounts.create({ clientId, dni, passwordHash: await hasher.hash('Secret123') });
  const res = await request(app).post('/api/portal/auth/login').send({ dni, password: 'Secret123' });
  return res.body.accessToken as string;
}

describe('portal-usage-metrics — GET /api/portal/usage/:contractId', () => {
  it('devuelve el contrato wire COMPLETO, con los bytes como number (JSON no serializa BigInt)', async () => {
    const { app, accounts, hasher, reader } = buildStack();
    const token = await loginAs(app, accounts, hasher, 'client-a');
    reader.record({
      sourceUniqueId: 's1',
      username: 'juan.perez',
      startedAt: new Date('2026-08-02T15:00:00.000Z'),
      stoppedAt: new Date('2026-08-02T20:00:00.000Z'),
      bytesIn: BigInt(30 * GB),
      bytesOut: BigInt(700 * GB),
    });

    const res = await request(app).get('/api/portal/usage/c1').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      available: true,
      approximate: false, // sesión 100% contenida en el mes: números EXACTOS
      period: { from: '2026-08-01', to: '2026-08-05' },
      downloadBytes: 700 * GB,
      uploadBytes: 30 * GB,
      totalBytes: 730 * GB,
      daily: [
        { date: '2026-08-01', downloadBytes: 0, uploadBytes: 0 },
        { date: '2026-08-02', downloadBytes: 700 * GB, uploadBytes: 30 * GB },
        { date: '2026-08-03', downloadBytes: 0, uploadBytes: 0 },
        { date: '2026-08-04', downloadBytes: 0, uploadBytes: 0 },
        { date: '2026-08-05', downloadBytes: 0, uploadBytes: 0 },
      ],
      peakDay: { date: '2026-08-02', totalBytes: 730 * GB },
    });
    // El contrato promete NUMBERs: si algún día vuelve un BigInt, esto lo caza
    // antes de que el endpoint tire 500 al serializar.
    expect(typeof res.body.downloadBytes).toBe('number');
    expect(typeof res.body.daily[1].downloadBytes).toBe('number');
  });

  it('anti-IDOR: contrato AJENO -> 404 con el MISMO body que un contrato inexistente', async () => {
    const { app, accounts, hasher } = buildStack({
      contracts: { 'client-a': [makeContract('c1')], 'client-b': [makeContract('c2')] },
      pppoe: { c1: [makePppoe('juan.perez', 'c1')], c2: [makePppoe('ajeno', 'c2')] },
    });
    const token = await loginAs(app, accounts, hasher, 'client-a');

    const ajeno = await request(app).get('/api/portal/usage/c2').set('Authorization', `Bearer ${token}`);
    const inexistente = await request(app).get('/api/portal/usage/no-existe').set('Authorization', `Bearer ${token}`);

    expect(ajeno.status).toBe(404);
    expect(inexistente.status).toBe(404);
    expect(ajeno.body).toEqual(inexistente.body);
  });

  it('contrato SIN PPPoE -> 200 con available:false (estado NORMAL, no un 404 ni un 500)', async () => {
    const { app, accounts, hasher } = buildStack({ pppoe: {} });
    const token = await loginAs(app, accounts, hasher, 'client-a');

    const res = await request(app).get('/api/portal/usage/c1').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      available: false,
      approximate: false,
      period: { from: '2026-08-01', to: '2026-08-05' },
      downloadBytes: 0,
      uploadBytes: 0,
      totalBytes: 0,
      daily: [],
      peakDay: null,
    });
  });

  it('C1 wire: la sesión always-on nacida el mes anterior viaja PRORRATEADA con approximate:true (antes: 0 bytes)', async () => {
    const { app, accounts, hasher, reader } = buildStack();
    const token = await loginAs(app, accounts, hasher, 'client-a');
    // Nació el 26/7 14:00Z, sigue viva: 10 días totales, 385.200.000 ms solapan
    // agosto → 864 GB × fracción = 385,2 GB del período.
    reader.record({
      sourceUniqueId: 'always-on',
      username: 'juan.perez',
      startedAt: new Date('2026-07-26T14:00:00.000Z'),
      stoppedAt: null,
      bytesIn: BigInt(86.4 * GB),
      bytesOut: BigInt(864 * GB),
    });

    const res = await request(app).get('/api/portal/usage/c1').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.approximate).toBe(true);
    expect(res.body.downloadBytes).toBe(385_200_000_000);
    expect(res.body.uploadBytes).toBe(38_520_000_000);
    expect(typeof res.body.downloadBytes).toBe('number'); // sigue siendo serializable
  });

  it('sin token -> 401 (la ruta está detrás de portalAuthMiddleware)', async () => {
    const { app } = buildStack();

    const res = await request(app).get('/api/portal/usage/c1');

    expect(res.status).toBe(401);
  });
});
