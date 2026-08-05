/**
 * wifi-guest-pending — route-level coverage del estado PENDIENTE de la red de
 * visitas (contrato FIJO con la app — se consume tal cual):
 *  - `PUT  /guest` y `POST /guest/disable` agregan `guestPending`
 *    (status 'in_progress') a su respuesta actual `{applied:true}`.
 *  - Con un intent 'in_progress' vigente, un nuevo PUT/disable -> 409 con body
 *    EXACTO `{ error: 'guest_change_pending' }`.
 *  - Con status 'unconfirmed' (>= 10 min) el reintento SE PERMITE.
 *  - `GET /wifi/:contractId` expone `guestPending` mientras el intent viva.
 * Molde `portalWifiGuest.routes.test.ts` (app Express real + fakes in-memory,
 * JAMÁS SmartOLT real). Reloj inyectado en los use cases (mutable) para
 * recorrer las ventanas de 3/10 min sin sleeps.
 */
import express from 'express';
import request from 'supertest';

import { createPortalRouter } from '@infrastructure/http/routes/portal.routes';
import { createPortalAuthMiddleware } from '@infrastructure/http/middleware/portalAuthMiddleware';
import { createPortalKillSwitchMiddleware } from '@infrastructure/http/middleware/portalKillSwitchMiddleware';
import { createPortalGeneralRateLimiter, createPortalWifiUpdateRateLimiter } from '@infrastructure/http/middleware/rateLimiters';

import { InMemoryPortalAccountRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalAccountRepository';
import { InMemoryPortalSessionRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalSessionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { InMemorySettingsRepository } from '@infrastructure/adapters/in-memory/InMemorySettingsRepository';
import { JwtPortalTokenService } from '@infrastructure/adapters/jwt/JwtPortalTokenService';
import { InMemoryContractInventoryRepository } from '@infrastructure/adapters/in-memory/InMemoryContractInventoryRepository';
import { InMemoryOnuWifiCredentialRepository } from '@infrastructure/adapters/in-memory/InMemoryOnuWifiCredentialRepository';
import { InMemoryWifiGuestIntentRepository } from '@infrastructure/adapters/in-memory/InMemoryWifiGuestIntentRepository';
import { InMemoryOltProvisioningGateway } from '@infrastructure/adapters/in-memory/InMemoryOltProvisioningGateway';

import { PortalLogin } from '@application/use-cases/portal/PortalLogin';
import { ResolveWifiEligibility } from '@application/use-cases/wifi/ResolveWifiEligibility';
import { GetPortalWifiStatus } from '@application/use-cases/wifi/GetPortalWifiStatus';
import { UpdatePortalWifiGuest } from '@application/use-cases/wifi/UpdatePortalWifiGuest';
import { DisablePortalWifiGuest } from '@application/use-cases/wifi/DisablePortalWifiGuest';

import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { Contract } from '@domain/entities/customer';
import type { ContractInstalledItem } from '@domain/entities/contract-installed-item';
import type { RawWifiPort } from '@domain/services/mapWifiPortsToBands';

const TEST_SECRET = 'test-jwt-secret-32chars-minimum!';
const SN = 'HWTC189C07AA';
const RAW_SERIAL = '48575443189C07AA';

const T0 = Date.parse('2026-08-05T12:00:00.000Z');
const T0_ISO = '2026-08-05T12:00:00.000Z';
const MIN = 60_000;

function makeContract(overrides: Partial<Contract> & { id: string }): Contract {
  return {
    code: null, type: 'internet', plan: '50 Mb Simetrico', ip: '10.0.0.1', status: 'active',
    startDate: '2025-01-01T00:00:00.000Z', endDate: '', address: null, lat: null, lng: null,
    technology: null, name: null, vendedor: null, services: [],
    ...overrides,
  };
}

function fakeCustomers(byClient: Record<string, Contract[]>): Pick<CustomerRepository, 'listContracts'> {
  return { listContracts: async (clientId: string) => byClient[clientId] ?? [] };
}

function makeItem(overrides: Partial<ContractInstalledItem> & { contractId: string; type: string }): ContractInstalledItem {
  return {
    id: `item-${Math.random()}`, serialNumber: null, mac: null, model: null, source: 'MANUAL',
    sourceTaskId: null, addedByUserId: null, confirmedAt: null, status: 'active', notes: null,
    replacesItemId: null, assetId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const EIGHT_PORTS: RawWifiPort[] = [
  { port: 'wifi_0/1', ssid: 'Casa', enabled: true },
  { port: 'wifi_0/2', ssid: 'Visitas_Casa', enabled: true },
  { port: 'wifi_0/3', ssid: null, enabled: false },
  { port: 'wifi_0/4', ssid: null, enabled: false },
  { port: 'wifi_0/5', ssid: 'Casa_5G', enabled: true },
  { port: 'wifi_0/6', ssid: null, enabled: false },
  { port: 'wifi_0/7', ssid: null, enabled: false },
  { port: 'wifi_0/8', ssid: null, enabled: false },
];

function buildStack() {
  const accounts = new InMemoryPortalAccountRepository();
  const sessions = new InMemoryPortalSessionRepository();
  const hasher = new InMemoryPasswordHasher();
  const settingsRepo = new InMemorySettingsRepository();
  const tokenService = new JwtPortalTokenService(TEST_SECRET);

  const portalLogin = new PortalLogin(accounts, sessions, hasher, tokenService);
  const portalAuthMiddleware = createPortalAuthMiddleware(tokenService, accounts);
  const killSwitch = createPortalKillSwitchMiddleware(settingsRepo, 30_000);
  const generalRateLimiter = createPortalGeneralRateLimiter({ windowMs: 60_000, limit: 1000 });
  const wifiUpdateRateLimiter = createPortalWifiUpdateRateLimiter({ windowMs: 60_000, limit: 100 });

  const inventory = new InMemoryContractInventoryRepository();
  const gw = new InMemoryOltProvisioningGateway();
  const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
  const credentials = new InMemoryOnuWifiCredentialRepository();
  const intents = new InMemoryWifiGuestIntentRepository();

  let nowMs = T0;
  const now = () => nowMs;

  const resolveWifiEligibility = new ResolveWifiEligibility(customers, inventory, gw);
  const getPortalWifiStatus = new GetPortalWifiStatus(resolveWifiEligibility, gw, credentials, intents, now);
  const updatePortalWifiGuest = new UpdatePortalWifiGuest(resolveWifiEligibility, gw, credentials, intents, now);
  const disablePortalWifiGuest = new DisablePortalWifiGuest(resolveWifiEligibility, gw, intents, now);

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
      wifiUpdateRateLimiter,
      getPortalWifiStatus,
      updatePortalWifiGuest,
      disablePortalWifiGuest,
    }),
  );

  return { app, accounts, hasher, inventory, gw, intents, setNow: (ms: number) => { nowMs = ms; } };
}

async function loginAs(app: express.Express, accounts: InMemoryPortalAccountRepository, hasher: InMemoryPasswordHasher, clientId: string): Promise<string> {
  const dni = `dni-${clientId}`;
  await accounts.create({ clientId, dni, passwordHash: await hasher.hash('Secret123') });
  const res = await request(app).post('/api/portal/auth/login').send({ dni, password: 'Secret123' });
  return res.body.accessToken as string;
}

async function seedOnu(stack: ReturnType<typeof buildStack>) {
  await stack.inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: RAW_SERIAL }));
  stack.gw.wifiOnus.set(SN, { onuType: 'EG8041V5', online: true, tr069Enabled: true, ports: EIGHT_PORTS });
}

describe('wifi-guest-pending — contrato de rutas', () => {
  it('PUT /guest: 200 con guestPending creating/in_progress ADEMÁS de applied (shape EXACTO: applied + guestPending)', async () => {
    const stack = buildStack();
    await seedOnu(stack);
    const token = await loginAs(stack.app, stack.accounts, stack.hasher, 'client-a');

    const res = await request(stack.app)
      .put('/api/portal/wifi/c1/guest')
      .set('Authorization', `Bearer ${token}`)
      .send({ band: '2.4', ssid: 'Visitas', password: 'clave1234' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      applied: true,
      guestPending: { action: 'creating', since: T0_ISO, status: 'in_progress' },
    });
  });

  it('POST /guest/disable: 200 con guestPending deleting/in_progress', async () => {
    const stack = buildStack();
    await seedOnu(stack);
    const token = await loginAs(stack.app, stack.accounts, stack.hasher, 'client-a');

    const res = await request(stack.app)
      .post('/api/portal/wifi/c1/guest/disable')
      .set('Authorization', `Bearer ${token}`)
      .send({ band: '2.4' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      applied: true,
      guestPending: { action: 'deleting', since: T0_ISO, status: 'in_progress' },
    });
  });

  it('409 en pending: con un cambio en vuelo, PUT y disable responden 409 con body EXACTO {error:"guest_change_pending"}', async () => {
    const stack = buildStack();
    await seedOnu(stack);
    const token = await loginAs(stack.app, stack.accounts, stack.hasher, 'client-a');

    await request(stack.app)
      .post('/api/portal/wifi/c1/guest/disable')
      .set('Authorization', `Bearer ${token}`)
      .send({ band: '2.4' });

    const resPut = await request(stack.app)
      .put('/api/portal/wifi/c1/guest')
      .set('Authorization', `Bearer ${token}`)
      .send({ band: '2.4', ssid: 'Visitas', password: 'clave1234' });
    const resDisable = await request(stack.app)
      .post('/api/portal/wifi/c1/guest/disable')
      .set('Authorization', `Bearer ${token}`)
      .send({ band: '5' });

    expect(resPut.status).toBe(409);
    expect(resPut.body).toEqual({ error: 'guest_change_pending' });
    expect(resDisable.status).toBe(409);
    expect(resDisable.body).toEqual({ error: 'guest_change_pending' });
    // El gateway solo vio la PRIMERA escritura.
    expect(stack.gw.calls.filter((c) => c.method === 'shutdownWifiPort' || c.method === 'setWifiBand')).toHaveLength(1);
  });

  it('GET refleja guestPending mientras el intent viva; sin intent el campo NO está', async () => {
    const stack = buildStack();
    await seedOnu(stack);
    const token = await loginAs(stack.app, stack.accounts, stack.hasher, 'client-a');

    const before = await request(stack.app).get('/api/portal/wifi/c1').set('Authorization', `Bearer ${token}`);
    expect(before.body).not.toHaveProperty('guestPending');

    await request(stack.app)
      .put('/api/portal/wifi/c1/guest')
      .set('Authorization', `Bearer ${token}`)
      .send({ band: '2.4', ssid: 'Visitas', password: 'clave1234' });

    const after = await request(stack.app).get('/api/portal/wifi/c1').set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(200);
    expect(after.body.guestPending).toEqual({ action: 'creating', since: T0_ISO, status: 'in_progress' });
  });

  it('unconfirmed a los 10 permite REINTENTAR: la baja no confirmada -> GET unconfirmed -> nuevo disable 200 con intent fresco', async () => {
    const stack = buildStack();
    await seedOnu(stack);
    const token = await loginAs(stack.app, stack.accounts, stack.hasher, 'client-a');
    // La radio sigue al aire en WLAN 2 (caso real EG8041V5: push TR-069 perdido).
    stack.gw.onlineWifiMacsBySn.set(SN, [{ wlanIndex: 2, mac: '1e:be:33:9b:97:b2' }]);

    await request(stack.app)
      .post('/api/portal/wifi/c1/guest/disable')
      .set('Authorization', `Bearer ${token}`)
      .send({ band: '2.4' });

    stack.setNow(T0 + 10 * MIN);
    const get = await request(stack.app).get('/api/portal/wifi/c1').set('Authorization', `Bearer ${token}`);
    expect(get.body.guestPending).toEqual({ action: 'deleting', since: T0_ISO, status: 'unconfirmed' });

    const retry = await request(stack.app)
      .post('/api/portal/wifi/c1/guest/disable')
      .set('Authorization', `Bearer ${token}`)
      .send({ band: '2.4' });

    expect(retry.status).toBe(200);
    expect(retry.body.guestPending).toEqual({
      action: 'deleting',
      since: new Date(T0 + 10 * MIN).toISOString(),
      status: 'in_progress',
    });
    expect(stack.intents.all()).toEqual([
      expect.objectContaining({ action: 'deleting', since: new Date(T0 + 10 * MIN).toISOString(), retriedAt: null }),
    ]);
  });
});
