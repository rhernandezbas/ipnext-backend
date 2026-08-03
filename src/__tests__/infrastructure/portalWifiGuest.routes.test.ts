/**
 * EPIC v3 (wifi de visitas + red por dispositivo) — route-level coverage de:
 *   - `GET  /api/portal/wifi/:contractId` (campo ADITIVO `guest`)
 *   - `PUT  /api/portal/wifi/:contractId/guest`
 *   - `POST /api/portal/wifi/:contractId/guest/disable`
 *   - `GET  /api/portal/wifi/:contractId/devices` (campo ADITIVO `wlanIndex`)
 * sobre la app Express real + `InMemoryOltProvisioningGateway` extendido con
 * estado de puertos (molde `portalWifi.routes.test.ts`). Incluye el test de
 * CONGELAMIENTO del shape viejo de `PortalWifiDto`/`PortalWifiDeviceDto` —
 * `/api/portal/*` es contrato PÚBLICO: solo se agrega, jamás se cambia.
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
import { InMemoryOltProvisioningGateway } from '@infrastructure/adapters/in-memory/InMemoryOltProvisioningGateway';

import { PortalLogin } from '@application/use-cases/portal/PortalLogin';
import { ResolveWifiEligibility } from '@application/use-cases/wifi/ResolveWifiEligibility';
import { GetPortalWifiStatus } from '@application/use-cases/wifi/GetPortalWifiStatus';
import { UpdatePortalWifiBand } from '@application/use-cases/wifi/UpdatePortalWifiBand';
import { UpdatePortalWifiGuest } from '@application/use-cases/wifi/UpdatePortalWifiGuest';
import { DisablePortalWifiGuest } from '@application/use-cases/wifi/DisablePortalWifiGuest';
import { ListPortalWifiDevices } from '@application/use-cases/wifi/ListPortalWifiDevices';

import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { Contract } from '@domain/entities/customer';
import type { ContractInstalledItem } from '@domain/entities/contract-installed-item';
import type { RawWifiPort } from '@domain/services/mapWifiPortsToBands';

const TEST_SECRET = 'test-jwt-secret-32chars-minimum!';
const SN = 'HWTC189C07AA';
const RAW_SERIAL = '48575443189C07AA';

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

/** Template completo — visita disponible en AMBAS bandas. */
const EIGHT_PORTS: RawWifiPort[] = [
  { port: 'wifi_0/1', ssid: 'Casa', enabled: true },
  { port: 'wifi_0/2', ssid: null, enabled: false },
  { port: 'wifi_0/3', ssid: null, enabled: false },
  { port: 'wifi_0/4', ssid: null, enabled: false },
  { port: 'wifi_0/5', ssid: 'Casa_5G', enabled: true },
  { port: 'wifi_0/6', ssid: null, enabled: false },
  { port: 'wifi_0/7', ssid: null, enabled: false },
  { port: 'wifi_0/8', ssid: null, enabled: false },
];

/** Template real HWTCA92F96B1 (2026-08-03) — SIN puertos 5GHz. */
const TWO_PORTS: RawWifiPort[] = [
  { port: 'wifi_0/1', ssid: 'Luis', enabled: true },
  { port: 'wifi_0/2', ssid: null, enabled: false },
];

function buildStack(opts?: { customers?: Pick<CustomerRepository, 'listContracts'>; wifiUpdateLimit?: number }) {
  const accounts = new InMemoryPortalAccountRepository();
  const sessions = new InMemoryPortalSessionRepository();
  const hasher = new InMemoryPasswordHasher();
  const settingsRepo = new InMemorySettingsRepository();
  const tokenService = new JwtPortalTokenService(TEST_SECRET);

  const portalLogin = new PortalLogin(accounts, sessions, hasher, tokenService);
  const portalAuthMiddleware = createPortalAuthMiddleware(tokenService, accounts);
  const killSwitch = createPortalKillSwitchMiddleware(settingsRepo, 30_000);
  const generalRateLimiter = createPortalGeneralRateLimiter({ windowMs: 60_000, limit: 1000 });
  // Instancia ÚNICA compartida por el PUT principal Y los dos endpoints guest —
  // pinea la decisión "un solo presupuesto de escrituras que tocan la radio".
  const wifiUpdateRateLimiter = createPortalWifiUpdateRateLimiter({ windowMs: 60_000, limit: opts?.wifiUpdateLimit ?? 5 });

  const inventory = new InMemoryContractInventoryRepository();
  const gw = new InMemoryOltProvisioningGateway();
  const customers = opts?.customers ?? fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
  const credentials = new InMemoryOnuWifiCredentialRepository();

  const resolveWifiEligibility = new ResolveWifiEligibility(customers, inventory, gw);
  const getPortalWifiStatus = new GetPortalWifiStatus(resolveWifiEligibility, gw, credentials);
  const updatePortalWifiBand = new UpdatePortalWifiBand(resolveWifiEligibility, gw, credentials);
  const updatePortalWifiGuest = new UpdatePortalWifiGuest(resolveWifiEligibility, gw, credentials);
  const disablePortalWifiGuest = new DisablePortalWifiGuest(resolveWifiEligibility, gw);
  const listPortalWifiDevices = new ListPortalWifiDevices(resolveWifiEligibility, gw);

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
      updatePortalWifiBand,
      updatePortalWifiGuest,
      disablePortalWifiGuest,
      listPortalWifiDevices,
    }),
  );

  return { app, accounts, hasher, inventory, gw };
}

async function loginAs(app: express.Express, accounts: InMemoryPortalAccountRepository, hasher: InMemoryPasswordHasher, clientId: string): Promise<string> {
  const dni = `dni-${clientId}`;
  await accounts.create({ clientId, dni, passwordHash: await hasher.hash('Secret123') });
  const res = await request(app).post('/api/portal/auth/login').send({ dni, password: 'Secret123' });
  return res.body.accessToken as string;
}

async function seedOnu(stack: ReturnType<typeof buildStack>, ports: RawWifiPort[]) {
  await stack.inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: RAW_SERIAL }));
  stack.gw.wifiOnus.set(SN, { onuType: 'HG8145V5', online: true, tr069Enabled: true, ports });
}

describe('EPIC v3 — GET /api/portal/wifi/:contractId con guest (aditivo)', () => {
  it('eligible: suma `guest.bands` con las DOS bandas SIEMPRE (available según el template)', async () => {
    const stack = buildStack();
    await seedOnu(stack, TWO_PORTS);
    const token = await loginAs(stack.app, stack.accounts, stack.hasher, 'client-a');

    const res = await request(stack.app).get('/api/portal/wifi/c1').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.guest).toEqual({
      bands: [
        { band: '2.4', available: true, ssid: null, enabled: false },
        { band: '5', available: false, ssid: null, enabled: false },
      ],
    });
  });

  it('no eligible: `guest` AUSENTE (solo presente cuando eligible)', async () => {
    const stack = buildStack();
    const token = await loginAs(stack.app, stack.accounts, stack.hasher, 'client-a');

    const res = await request(stack.app).get('/api/portal/wifi/c1').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ eligible: false, reason: 'no_onu' });
  });

  it('CONGELAMIENTO del shape viejo: los campos EXISTENTES de PortalWifiDto no cambian (contrato público, solo aditivo)', async () => {
    const stack = buildStack();
    await seedOnu(stack, EIGHT_PORTS);
    stack.gw.routerHostsBySn.set(SN, [
      { hostName: 'iPhone', ip: '10.0.0.5', mac: 'AA', interfaceType: 'wifi', active: true, vendor: null, wlanIndex: 1 },
    ]);
    const token = await loginAs(stack.app, stack.accounts, stack.hasher, 'client-a');

    const res = await request(stack.app).get('/api/portal/wifi/c1').set('Authorization', `Bearer ${token}`);

    // Top-level: los 3 campos viejos + `guest` (el ÚNICO agregado).
    expect(Object.keys(res.body).sort()).toEqual(['bands', 'connectedCount', 'eligible', 'guest']);
    expect(res.body.eligible).toBe(true);
    expect(res.body.connectedCount).toBe(1);
    // Cada banda conserva EXACTAMENTE sus 3 campos (band/ssid/password).
    for (const b of res.body.bands) {
      expect(Object.keys(b).sort()).toEqual(['band', 'password', 'ssid']);
    }
    expect(res.body.bands).toEqual([
      { band: '2.4', ssid: 'Casa', password: null },
      { band: '5', ssid: 'Casa_5G', password: null },
    ]);
  });
});

describe('EPIC v3 — PUT /api/portal/wifi/:contractId/guest', () => {
  it('happy path: 200 {applied:true}; aplica al puerto de visita y el próximo GET lo refleja', async () => {
    const stack = buildStack();
    await seedOnu(stack, EIGHT_PORTS);
    const token = await loginAs(stack.app, stack.accounts, stack.hasher, 'client-a');

    const res = await request(stack.app)
      .put('/api/portal/wifi/c1/guest')
      .set('Authorization', `Bearer ${token}`)
      .send({ band: '2.4', ssid: 'Visitas_Casa', password: 'clave1234' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ applied: true });
    expect(stack.gw.calls).toEqual([
      { method: 'setWifiBand', sn: SN, input: { port: 'wifi_0/2', ssid: 'Visitas_Casa', password: 'clave1234' } },
    ]);

    const getRes = await request(stack.app).get('/api/portal/wifi/c1').set('Authorization', `Bearer ${token}`);
    expect(getRes.body.guest.bands.find((b: { band: string }) => b.band === '2.4')).toEqual({
      band: '2.4', available: true, ssid: 'Visitas_Casa', enabled: true,
    });
  });

  it('banda NO disponible en el template -> 409 GUEST_BAND_UNAVAILABLE y el gateway NUNCA se llama', async () => {
    const stack = buildStack();
    await seedOnu(stack, TWO_PORTS);
    const token = await loginAs(stack.app, stack.accounts, stack.hasher, 'client-a');

    const res = await request(stack.app)
      .put('/api/portal/wifi/c1/guest')
      .set('Authorization', `Bearer ${token}`)
      .send({ band: '5', ssid: 'Visitas', password: 'clave1234' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('GUEST_BAND_UNAVAILABLE');
    expect(stack.gw.calls).toHaveLength(0);
  });

  it('re-verifica elegibilidad ENTERA: pierde TR-069 entre el GET y el PUT -> 409 WIFI_NOT_ELIGIBLE', async () => {
    const stack = buildStack();
    await seedOnu(stack, EIGHT_PORTS);
    const token = await loginAs(stack.app, stack.accounts, stack.hasher, 'client-a');

    stack.gw.wifiOnus.set(SN, { onuType: 'HG8145V5', online: true, tr069Enabled: false, ports: EIGHT_PORTS });

    const res = await request(stack.app)
      .put('/api/portal/wifi/c1/guest')
      .set('Authorization', `Bearer ${token}`)
      .send({ band: '2.4', ssid: 'Visitas', password: 'clave1234' });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'WIFI_NOT_ELIGIBLE', reason: 'no_tr069' });
    expect(stack.gw.calls).toHaveLength(0);
  });

  it('anti-IDOR: contrato ajeno -> 404 indistinguible', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })], 'client-b': [makeContract({ id: 'c2' })] });
    const stack = buildStack({ customers });
    const token = await loginAs(stack.app, stack.accounts, stack.hasher, 'client-a');

    const body = { band: '2.4', ssid: 'X', password: 'clave1234' };
    const resForeign = await request(stack.app).put('/api/portal/wifi/c2/guest').set('Authorization', `Bearer ${token}`).send(body);
    const resMissing = await request(stack.app).put('/api/portal/wifi/no-existe/guest').set('Authorization', `Bearer ${token}`).send(body);

    expect(resForeign.status).toBe(404);
    expect(resMissing.status).toBe(404);
    expect(resForeign.body).toEqual(resMissing.body);
  });

  it('mismas reglas de forma que el update principal: password de 7 chars -> 400', async () => {
    const stack = buildStack();
    await seedOnu(stack, EIGHT_PORTS);
    const token = await loginAs(stack.app, stack.accounts, stack.hasher, 'client-a');

    const res = await request(stack.app)
      .put('/api/portal/wifi/c1/guest')
      .set('Authorization', `Bearer ${token}`)
      .send({ band: '2.4', ssid: 'X', password: '1234567' });

    expect(res.status).toBe(400);
    expect(stack.gw.calls).toHaveLength(0);
  });
});

describe('EPIC v3 — POST /api/portal/wifi/:contractId/guest/disable', () => {
  it('happy path: 200 {applied:true}; shutdownWifiPort al puerto de visita y el GET lo refleja', async () => {
    const stack = buildStack();
    await seedOnu(stack, [
      { port: 'wifi_0/1', ssid: 'Casa', enabled: true },
      { port: 'wifi_0/2', ssid: 'Visitas_Casa', enabled: true },
      { port: 'wifi_0/5', ssid: 'Casa_5G', enabled: true },
      { port: 'wifi_0/6', ssid: null, enabled: false },
    ]);
    const token = await loginAs(stack.app, stack.accounts, stack.hasher, 'client-a');

    const res = await request(stack.app)
      .post('/api/portal/wifi/c1/guest/disable')
      .set('Authorization', `Bearer ${token}`)
      .send({ band: '2.4' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ applied: true });
    expect(stack.gw.calls).toEqual([{ method: 'shutdownWifiPort', sn: SN, port: 'wifi_0/2' }]);

    const getRes = await request(stack.app).get('/api/portal/wifi/c1').set('Authorization', `Bearer ${token}`);
    expect(getRes.body.guest.bands.find((b: { band: string }) => b.band === '2.4')!.enabled).toBe(false);
  });

  it('banda NO disponible -> 409 GUEST_BAND_UNAVAILABLE sin tocar el gateway', async () => {
    const stack = buildStack();
    await seedOnu(stack, TWO_PORTS);
    const token = await loginAs(stack.app, stack.accounts, stack.hasher, 'client-a');

    const res = await request(stack.app)
      .post('/api/portal/wifi/c1/guest/disable')
      .set('Authorization', `Bearer ${token}`)
      .send({ band: '5' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('GUEST_BAND_UNAVAILABLE');
    expect(stack.gw.calls).toHaveLength(0);
  });

  it('body con banda inválida -> 400 VALIDATION_ERROR', async () => {
    const stack = buildStack();
    await seedOnu(stack, EIGHT_PORTS);
    const token = await loginAs(stack.app, stack.accounts, stack.hasher, 'client-a');

    const res = await request(stack.app)
      .post('/api/portal/wifi/c1/guest/disable')
      .set('Authorization', `Bearer ${token}`)
      .send({ band: '6' });

    expect(res.status).toBe(400);
  });
});

describe('EPIC v3 — rate limit COMPARTIDO entre el PUT principal y los endpoints guest', () => {
  it('5 escrituras mixtas agotan el MISMO presupuesto: la 6ta (guest) -> 429', async () => {
    const stack = buildStack({ wifiUpdateLimit: 5 });
    await seedOnu(stack, EIGHT_PORTS);
    const token = await loginAs(stack.app, stack.accounts, stack.hasher, 'client-a');

    // 3 cambios del WiFi principal + 2 del guest = 5 escrituras que tocan la radio.
    for (let i = 0; i < 3; i++) {
      const res = await request(stack.app)
        .put('/api/portal/wifi/c1')
        .set('Authorization', `Bearer ${token}`)
        .send({ band: '2.4', ssid: 'Casa', password: 'clave1234' });
      expect(res.status).toBe(200);
    }
    for (let i = 0; i < 2; i++) {
      const res = await request(stack.app)
        .put('/api/portal/wifi/c1/guest')
        .set('Authorization', `Bearer ${token}`)
        .send({ band: '2.4', ssid: 'Visitas', password: 'clave1234' });
      expect(res.status).toBe(200);
    }

    const sixth = await request(stack.app)
      .post('/api/portal/wifi/c1/guest/disable')
      .set('Authorization', `Bearer ${token}`)
      .send({ band: '2.4' });
    expect(sixth.status).toBe(429);
    expect(sixth.body.code).toBe('RATE_LIMITED');
  });
});

describe('EPIC v3 — GET /api/portal/wifi/:contractId/devices con wlanIndex (aditivo)', () => {
  it('cada device suma wlanIndex (número de puerto WiFi) y ethernet queda null; ip/mac SIGUEN afuera', async () => {
    const stack = buildStack();
    await seedOnu(stack, EIGHT_PORTS);
    stack.gw.routerHostsBySn.set(SN, [
      { hostName: 'A13-de-Blanca', ip: '10.22.22.9', mac: '9e:c3:9d:2f:f6:b6', interfaceType: 'wifi', active: false, vendor: 'android-dhcp-14', wlanIndex: 1 },
      { hostName: 'PC-Escritorio', ip: '10.22.22.77', mac: '8e:4e:b9:63:64:4a', interfaceType: 'ethernet', active: true, vendor: null, wlanIndex: null },
      { hostName: 'TV-Living', ip: '10.22.22.10', mac: 'aa:bb:cc', interfaceType: 'wifi', active: true, vendor: null, wlanIndex: 5 },
    ]);
    const token = await loginAs(stack.app, stack.accounts, stack.hasher, 'client-a');

    const res = await request(stack.app).get('/api/portal/wifi/c1/devices').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.devices).toEqual([
      { name: 'A13-de-Blanca', interface: 'wifi', active: false, wlanIndex: 1 },
      { name: 'PC-Escritorio', interface: 'ethernet', active: true, wlanIndex: null },
      { name: 'TV-Living', interface: 'wifi', active: true, wlanIndex: 5 },
    ]);
    // Shape-freeze del DTO viejo + el ÚNICO campo nuevo.
    for (const d of res.body.devices) {
      expect(Object.keys(d).sort()).toEqual(['active', 'interface', 'name', 'wlanIndex']);
    }
  });
});
