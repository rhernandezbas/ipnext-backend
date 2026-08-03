/**
 * wifi-self-service (F0) — route-level coverage de "Mi WiFi" del portal
 * (`GET/PUT /api/portal/wifi/:contractId`, `GET /api/portal/wifi/:contractId/devices`)
 * sobre la app Express real + repos in-memory (molde `portalPromos.routes.test.ts`).
 *
 * Cubre los casos TDD 4 (anti-IDOR), 5 (PUT re-verifica ENTERO — con
 * revert-probe manual documentado en el reporte final), 6 (validación
 * ssid/password), 7 (rate limit propio 5/hora), 8 (connectedCount solo
 * active=true, null si falla el fetch de hosts), 9 (devices SIN ip/mac).
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

import { PortalLogin } from '@application/use-cases/portal/PortalLogin';
import { ResolveWifiEligibility } from '@application/use-cases/wifi/ResolveWifiEligibility';
import { GetPortalWifiStatus } from '@application/use-cases/wifi/GetPortalWifiStatus';
import { UpdatePortalWifiBand } from '@application/use-cases/wifi/UpdatePortalWifiBand';
import { ListPortalWifiDevices } from '@application/use-cases/wifi/ListPortalWifiDevices';

import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { Contract } from '@domain/entities/customer';
import type { ContractInstalledItem } from '@domain/entities/contract-installed-item';
import type { WifiManagementPort, OnuWifiStatus, SetWifiBandInput, RouterHost } from '@domain/ports/WifiManagementPort';
import { OltProvisioningError } from '@domain/errors/smartolt';

const TEST_SECRET = 'test-jwt-secret-32chars-minimum!';

function makeContract(overrides: Partial<Contract> & { id: string }): Contract {
  return {
    code: null,
    type: 'internet',
    plan: '50 Mb Simetrico',
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
    ...overrides,
  };
}

function fakeCustomers(byClient: Record<string, Contract[]>): Pick<CustomerRepository, 'listContracts'> {
  return { listContracts: async (clientId: string) => byClient[clientId] ?? [] };
}

function makeItem(overrides: Partial<ContractInstalledItem> & { contractId: string; type: string }): ContractInstalledItem {
  return {
    id: `item-${Math.random()}`,
    serialNumber: null,
    mac: null,
    model: null,
    source: 'MANUAL',
    sourceTaskId: null,
    addedByUserId: null,
    confirmedAt: null,
    status: 'active',
    notes: null,
    replacesItemId: null,
    assetId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const ELIGIBLE_STATUS: OnuWifiStatus = {
  found: true,
  onuType: 'HG8145V5',
  online: true,
  tr069Enabled: true,
  bands: [
    { band: '2.4', port: 'wifi_0/1', ssid: 'Casa', enabled: true },
    { band: '5', port: 'wifi_0/5', ssid: 'Casa_5G', enabled: true },
  ],
};

/** Fake controlable — permite simular "la ONU pierde TR-069 entre el GET y el PUT" (caso 5). */
class FakeWifiManagementPort implements WifiManagementPort {
  statusBySn = new Map<string, OnuWifiStatus>();
  hostsBySn = new Map<string, RouterHost[]>();
  hostsShouldFailForSn = new Set<string>();
  setWifiBandCalls: Array<{ sn: string; input: SetWifiBandInput }> = [];
  /** wifi-self-service (F0) caso 11 — sin SMARTOLT_API_KEY: `not_configured` SIEMPRE, ANTES de mirar statusBySn. */
  notConfigured = false;

  async getOnuWifiStatus(sn: string): Promise<OnuWifiStatus> {
    if (this.notConfigured) throw new OltProvisioningError('not_configured', 'SmartOLT no configurado');
    const s = this.statusBySn.get(sn);
    if (!s) throw new OltProvisioningError('rejected', 'not found');
    return s;
  }

  async setWifiBand(sn: string, input: SetWifiBandInput): Promise<void> {
    this.setWifiBandCalls.push({ sn, input });
  }

  async getRouterHosts(sn: string): Promise<RouterHost[]> {
    if (this.hostsShouldFailForSn.has(sn)) throw new Error('SmartOLT hosts timeout');
    return this.hostsBySn.get(sn) ?? [];
  }

  // EPIC v3 (wifi de visitas) — requerido por WifiManagementPort; este suite no lo ejercita
  // (los endpoints guest se cubren en portalWifiGuest.routes.test.ts con el fake con estado).
  async shutdownWifiPort(): Promise<void> {}
}

function buildStack(opts?: {
  customers?: Pick<CustomerRepository, 'listContracts'>;
  wifiUpdateLimit?: number;
  credentials?: InMemoryOnuWifiCredentialRepository;
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
  const wifiUpdateRateLimiter = createPortalWifiUpdateRateLimiter({ windowMs: 60_000, limit: opts?.wifiUpdateLimit ?? 5 });

  const inventory = new InMemoryContractInventoryRepository();
  const wifi = new FakeWifiManagementPort();
  const customers = opts?.customers ?? fakeCustomers({});
  const credentials = opts?.credentials ?? new InMemoryOnuWifiCredentialRepository();

  const resolveWifiEligibility = new ResolveWifiEligibility(customers, inventory, wifi);
  const getPortalWifiStatus = new GetPortalWifiStatus(resolveWifiEligibility, wifi, credentials);
  const updatePortalWifiBand = new UpdatePortalWifiBand(resolveWifiEligibility, wifi, credentials);
  const listPortalWifiDevices = new ListPortalWifiDevices(resolveWifiEligibility, wifi);

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
      listPortalWifiDevices,
    }),
  );

  return { app, accounts, hasher, inventory, wifi, credentials };
}

async function loginAs(app: express.Express, accounts: InMemoryPortalAccountRepository, hasher: InMemoryPasswordHasher, clientId: string): Promise<string> {
  const dni = `dni-${clientId}`;
  await accounts.create({ clientId, dni, passwordHash: await hasher.hash('Secret123') });
  const res = await request(app).post('/api/portal/auth/login').send({ dni, password: 'Secret123' });
  return res.body.accessToken as string;
}

describe('wifi-self-service (F0) — portal /api/portal/wifi', () => {
  it('caso 4 (anti-IDOR): GET de un contrato ajeno -> 404, indistinguible de "no existe"', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })], 'client-b': [makeContract({ id: 'c2' })] });
    const { app, accounts, hasher } = buildStack({ customers });
    const token = await loginAs(app, accounts, hasher, 'client-a');

    const resForeign = await request(app).get('/api/portal/wifi/c2').set('Authorization', `Bearer ${token}`);
    const resInexistent = await request(app).get('/api/portal/wifi/no-existe').set('Authorization', `Bearer ${token}`);

    expect(resForeign.status).toBe(404);
    expect(resInexistent.status).toBe(404);
    expect(resForeign.body).toEqual(resInexistent.body); // MISMO body — indistinguible.
  });

  it('caso 4 (anti-IDOR): PUT de un contrato ajeno -> 404, indistinguible', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })], 'client-b': [makeContract({ id: 'c2' })] });
    const { app, accounts, hasher } = buildStack({ customers });
    const token = await loginAs(app, accounts, hasher, 'client-a');

    const body = { band: '2.4', ssid: 'X', password: '12345678' };
    const resForeign = await request(app).put('/api/portal/wifi/c2').set('Authorization', `Bearer ${token}`).send(body);
    const resInexistent = await request(app).put('/api/portal/wifi/no-existe').set('Authorization', `Bearer ${token}`).send(body);

    expect(resForeign.status).toBe(404);
    expect(resInexistent.status).toBe(404);
    expect(resForeign.body).toEqual(resInexistent.body);
  });

  it('caso 5 — PUT RE-VERIFICA elegibilidad entera: la ONU pierde TR-069 entre el GET y el PUT -> 409, rechaza', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
    const { app, accounts, hasher, inventory, wifi } = buildStack({ customers });
    const token = await loginAs(app, accounts, hasher, 'client-a');
    await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' }));
    wifi.statusBySn.set('HWTC189C07AA', ELIGIBLE_STATUS);

    const getRes = await request(app).get('/api/portal/wifi/c1').set('Authorization', `Bearer ${token}`);
    expect(getRes.body.eligible).toBe(true);

    // Entre el GET y el PUT, la ONU pierde TR-069 (cambia el fake).
    wifi.statusBySn.set('HWTC189C07AA', { ...ELIGIBLE_STATUS, tr069Enabled: false });

    const putRes = await request(app)
      .put('/api/portal/wifi/c1')
      .set('Authorization', `Bearer ${token}`)
      .send({ band: '2.4', ssid: 'RedNueva', password: '12345678' });

    expect(putRes.status).toBe(409);
    expect(putRes.body).toMatchObject({ code: 'WIFI_NOT_ELIGIBLE', reason: 'no_tr069' });
    expect(wifi.setWifiBandCalls).toHaveLength(0); // NUNCA se aplicó el cambio.
  });

  it('caso 6 — validación: ssid vacío -> 400', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
    const { app, accounts, hasher, inventory, wifi } = buildStack({ customers });
    const token = await loginAs(app, accounts, hasher, 'client-a');
    await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' }));
    wifi.statusBySn.set('HWTC189C07AA', ELIGIBLE_STATUS);

    const res = await request(app).put('/api/portal/wifi/c1').set('Authorization', `Bearer ${token}`).send({ band: '2.4', ssid: '', password: '12345678' });
    expect(res.status).toBe(400);
    expect(wifi.setWifiBandCalls).toHaveLength(0);
  });

  it('caso 6 — validación: ssid de 33 chars -> 400', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
    const { app, accounts, hasher, inventory, wifi } = buildStack({ customers });
    const token = await loginAs(app, accounts, hasher, 'client-a');
    await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' }));
    wifi.statusBySn.set('HWTC189C07AA', ELIGIBLE_STATUS);

    const res = await request(app)
      .put('/api/portal/wifi/c1')
      .set('Authorization', `Bearer ${token}`)
      .send({ band: '2.4', ssid: 'X'.repeat(33), password: '12345678' });
    expect(res.status).toBe(400);
  });

  it('caso 6 — validación: password de 7 chars -> 400', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
    const { app, accounts, hasher, inventory, wifi } = buildStack({ customers });
    const token = await loginAs(app, accounts, hasher, 'client-a');
    await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' }));
    wifi.statusBySn.set('HWTC189C07AA', ELIGIBLE_STATUS);

    const res = await request(app).put('/api/portal/wifi/c1').set('Authorization', `Bearer ${token}`).send({ band: '2.4', ssid: 'X', password: '1234567' });
    expect(res.status).toBe(400);
  });

  it('caso 6 — validación: password de 64 chars -> 400', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
    const { app, accounts, hasher, inventory, wifi } = buildStack({ customers });
    const token = await loginAs(app, accounts, hasher, 'client-a');
    await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' }));
    wifi.statusBySn.set('HWTC189C07AA', ELIGIBLE_STATUS);

    const res = await request(app)
      .put('/api/portal/wifi/c1')
      .set('Authorization', `Bearer ${token}`)
      .send({ band: '2.4', ssid: 'X', password: 'X'.repeat(64) });
    expect(res.status).toBe(400);
  });

  it('caso 7 — rate limit: el 6to cambio en la ventana -> 429', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
    const { app, accounts, hasher, inventory, wifi } = buildStack({ customers, wifiUpdateLimit: 5 });
    const token = await loginAs(app, accounts, hasher, 'client-a');
    await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' }));
    wifi.statusBySn.set('HWTC189C07AA', ELIGIBLE_STATUS);

    const body = { band: '2.4', ssid: 'RedNueva', password: '12345678' };
    for (let i = 0; i < 5; i++) {
      const res = await request(app).put('/api/portal/wifi/c1').set('Authorization', `Bearer ${token}`).send(body);
      expect(res.status).toBe(200);
    }
    const sixth = await request(app).put('/api/portal/wifi/c1').set('Authorization', `Bearer ${token}`).send(body);
    expect(sixth.status).toBe(429);
    expect(sixth.body.code).toBe('RATE_LIMITED');
  });

  it('caso 8 — connectedCount cuenta SOLO active=true', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
    const { app, accounts, hasher, inventory, wifi } = buildStack({ customers });
    const token = await loginAs(app, accounts, hasher, 'client-a');
    await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' }));
    wifi.statusBySn.set('HWTC189C07AA', ELIGIBLE_STATUS);
    wifi.hostsBySn.set('HWTC189C07AA', [
      { hostName: 'A', ip: '1.1.1.1', mac: 'AA', interfaceType: 'wifi', active: true, vendor: null, wlanIndex: 1 },
      { hostName: 'B', ip: '1.1.1.2', mac: 'BB', interfaceType: 'wifi', active: false, vendor: null, wlanIndex: 1 },
      { hostName: 'C', ip: '1.1.1.3', mac: 'CC', interfaceType: 'ethernet', active: true, vendor: null, wlanIndex: null },
      { hostName: 'D', ip: '1.1.1.4', mac: 'DD', interfaceType: 'wifi', active: false, vendor: null, wlanIndex: 5 },
    ]);

    const res = await request(app).get('/api/portal/wifi/c1').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.connectedCount).toBe(2);
  });

  it('caso 8 — hosts caídos -> connectedCount:null, la ruta IGUAL responde 200', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
    const { app, accounts, hasher, inventory, wifi } = buildStack({ customers });
    const token = await loginAs(app, accounts, hasher, 'client-a');
    await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' }));
    wifi.statusBySn.set('HWTC189C07AA', ELIGIBLE_STATUS);
    wifi.hostsShouldFailForSn.add('HWTC189C07AA');

    const res = await request(app).get('/api/portal/wifi/c1').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.connectedCount).toBeNull();
    expect(res.body.eligible).toBe(true);
  });

  it('caso 9 — GET .../devices del portal NO incluye ip ni mac', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
    const { app, accounts, hasher, inventory, wifi } = buildStack({ customers });
    const token = await loginAs(app, accounts, hasher, 'client-a');
    await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' }));
    wifi.statusBySn.set('HWTC189C07AA', ELIGIBLE_STATUS);
    wifi.hostsBySn.set('HWTC189C07AA', [
      { hostName: 'iPhone', ip: '192.168.1.5', mac: 'AA:BB:CC', interfaceType: 'wifi', active: true, vendor: 'Apple', wlanIndex: 1 },
    ]);

    const res = await request(app).get('/api/portal/wifi/c1/devices').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    // EPIC v3 — `wlanIndex` es ADITIVO; ip/mac SIGUEN afuera del portal.
    expect(res.body.devices).toEqual([{ name: 'iPhone', interface: 'wifi', active: true, wlanIndex: 1 }]);
    expect(res.body.devices[0]).not.toHaveProperty('ip');
    expect(res.body.devices[0]).not.toHaveProperty('mac');
  });

  it('no_onu es un estado NORMAL (200), no un error', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
    const { app, accounts, hasher } = buildStack({ customers }); // sin item de inventario -> no_onu
    const token = await loginAs(app, accounts, hasher, 'client-a');

    const res = await request(app).get('/api/portal/wifi/c1').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ eligible: false, reason: 'no_onu' });
  });

  it('caso 11 — sin SMARTOLT_API_KEY: elegibilidad not_configured, 200, NADA explota', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
    const { app, accounts, hasher, inventory, wifi } = buildStack({ customers });
    const token = await loginAs(app, accounts, hasher, 'client-a');
    await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' }));
    wifi.notConfigured = true;

    const res = await request(app).get('/api/portal/wifi/c1').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ eligible: false, reason: 'not_configured' });
  });
});

/**
 * wifi-password-snapshot — SmartOLT nunca devuelve la password (verificado en
 * vivo, `get_onu_details` la trae SIEMPRE `null`); Prominense la recuerda en
 * `OnuWifiCredential` (upsert por sn+port) cada vez que alguien la escribe.
 * Cubre los casos TDD 1 (round-trip PUT->GET), 2 (banda nunca escrita ->
 * null, fixture de 2 bandas), 5 (snapshot falla -> el PUT IGUAL responde
 * 200), 6 (anti-IDOR: la password de otro cliente no se filtra) y la mitad
 * portal del 7 (`updatedBy: 'portal'`).
 */
describe('wifi-password-snapshot — portal /api/portal/wifi', () => {
  it('caso 1: tras un PUT, el GET devuelve la password escrita PARA ESA banda', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
    const { app, accounts, hasher, inventory, wifi } = buildStack({ customers });
    const token = await loginAs(app, accounts, hasher, 'client-a');
    await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' }));
    wifi.statusBySn.set('HWTC189C07AA', ELIGIBLE_STATUS);

    const putRes = await request(app)
      .put('/api/portal/wifi/c1')
      .set('Authorization', `Bearer ${token}`)
      .send({ band: '2.4', ssid: 'RedNueva', password: 'clave1234' });
    expect(putRes.status).toBe(200);

    const getRes = await request(app).get('/api/portal/wifi/c1').set('Authorization', `Bearer ${token}`);
    const band24 = getRes.body.bands.find((b: { band: string }) => b.band === '2.4');
    expect(band24.password).toBe('clave1234');
  });

  it('caso 2: banda NUNCA escrita por nosotros -> password:null (fixture de 2 bandas, una escrita y otra no)', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
    const { app, accounts, hasher, inventory, wifi } = buildStack({ customers });
    const token = await loginAs(app, accounts, hasher, 'client-a');
    await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' }));
    wifi.statusBySn.set('HWTC189C07AA', ELIGIBLE_STATUS); // 2 bandas: 2.4 y 5

    // Escribimos SOLO la 2.4 — la 5 nunca se tocó desde Prominense.
    await request(app)
      .put('/api/portal/wifi/c1')
      .set('Authorization', `Bearer ${token}`)
      .send({ band: '2.4', ssid: 'RedNueva', password: 'clave1234' });

    const getRes = await request(app).get('/api/portal/wifi/c1').set('Authorization', `Bearer ${token}`);
    const bands = getRes.body.bands as Array<{ band: string; password: string | null }>;
    expect(bands.find((b) => b.band === '2.4')!.password).toBe('clave1234');
    expect(bands.find((b) => b.band === '5')!.password).toBeNull();
  });

  it('caso 5: el snapshot falla al guardar -> el PUT IGUAL responde 200 (el equipo ya cambió)', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
    const { app, accounts, hasher, inventory, wifi, credentials } = buildStack({ customers });
    const token = await loginAs(app, accounts, hasher, 'client-a');
    await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' }));
    wifi.statusBySn.set('HWTC189C07AA', ELIGIBLE_STATUS);
    credentials.upsert = async () => {
      throw new Error('DB caída (simulado)');
    };

    const res = await request(app)
      .put('/api/portal/wifi/c1')
      .set('Authorization', `Bearer ${token}`)
      .send({ band: '2.4', ssid: 'RedNueva', password: 'clave1234' });

    expect(res.status).toBe(200);
    expect(wifi.setWifiBandCalls).toHaveLength(1); // el equipo SÍ se tocó.
  });

  it('caso 6 — anti-IDOR: la password de la ONU de OTRO cliente no se filtra (contrato ajeno -> 404, sin password)', async () => {
    const customers = fakeCustomers({
      'client-a': [makeContract({ id: 'c1' })],
      'client-b': [makeContract({ id: 'c2' })],
    });
    const { app, accounts, hasher, inventory, wifi } = buildStack({ customers });

    // client-b es el DUEÑO real de c2 y ya escribió su password.
    const tokenB = await loginAs(app, accounts, hasher, 'client-b');
    await inventory.create(makeItem({ contractId: 'c2', type: 'ONU', serialNumber: '48575443189C07AA' }));
    wifi.statusBySn.set('HWTC189C07AA', ELIGIBLE_STATUS);
    await request(app)
      .put('/api/portal/wifi/c2')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ band: '2.4', ssid: 'RedDeB', password: 'secretoDeB' });

    // client-a pide el contrato AJENO c2.
    const tokenA = await loginAs(app, accounts, hasher, 'client-a');
    const res = await request(app).get('/api/portal/wifi/c2').set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/secretoDeB/);
  });

  it('caso 7 (mitad portal): el PUT del portal guarda updatedBy:"portal"', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
    const { app, accounts, hasher, inventory, wifi, credentials } = buildStack({ customers });
    const token = await loginAs(app, accounts, hasher, 'client-a');
    await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' }));
    wifi.statusBySn.set('HWTC189C07AA', ELIGIBLE_STATUS);

    await request(app)
      .put('/api/portal/wifi/c1')
      .set('Authorization', `Bearer ${token}`)
      .send({ band: '2.4', ssid: 'RedNueva', password: 'clave1234' });

    const saved = credentials.all().find((c) => c.sn === 'HWTC189C07AA' && c.port === 'wifi_0/1');
    expect(saved?.updatedBy).toBe('portal');
  });
});
