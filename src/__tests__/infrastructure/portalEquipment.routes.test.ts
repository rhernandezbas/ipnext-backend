/**
 * portal-equipment-reboot — route-level coverage de "Reiniciar mi equipo"
 * (`GET /api/portal/equipment/:contractId`, `POST /api/portal/equipment/:contractId/reboot`)
 * sobre la app Express real + repos in-memory (molde `portalWifi.routes.test.ts`).
 *
 * Cubre los 6 casos TDD del reporte: (1) elegible SIN TR-069 — el caso que
 * separa reboot de wifi, (2) no_onu/not_configured como estados NORMALES,
 * (3) anti-IDOR, (4) POST re-verifica ENTERO (con revert-probe manual
 * documentado en el reporte final), (5) rate limit DURO 2/hora, (6) el POST
 * llama al gateway con la sn NORMALIZADA.
 */
import express from 'express';
import request from 'supertest';

import { createPortalRouter } from '@infrastructure/http/routes/portal.routes';
import { createPortalAuthMiddleware } from '@infrastructure/http/middleware/portalAuthMiddleware';
import { createPortalKillSwitchMiddleware } from '@infrastructure/http/middleware/portalKillSwitchMiddleware';
import { createPortalGeneralRateLimiter, createPortalEquipmentRebootRateLimiter } from '@infrastructure/http/middleware/rateLimiters';

import { InMemoryPortalAccountRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalAccountRepository';
import { InMemoryPortalSessionRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalSessionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { InMemorySettingsRepository } from '@infrastructure/adapters/in-memory/InMemorySettingsRepository';
import { JwtPortalTokenService } from '@infrastructure/adapters/jwt/JwtPortalTokenService';
import { InMemoryContractInventoryRepository } from '@infrastructure/adapters/in-memory/InMemoryContractInventoryRepository';

import { PortalLogin } from '@application/use-cases/portal/PortalLogin';
import { ResolveEquipmentRebootEligibility } from '@application/use-cases/equipment/ResolveEquipmentRebootEligibility';
import { GetPortalEquipmentStatus } from '@application/use-cases/equipment/GetPortalEquipmentStatus';
import { RebootPortalEquipment } from '@application/use-cases/equipment/RebootPortalEquipment';

import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { Contract } from '@domain/entities/customer';
import type { ContractInstalledItem } from '@domain/entities/contract-installed-item';
import type { WifiManagementPort, OnuWifiStatus } from '@domain/ports/WifiManagementPort';
import type { OltProvisioningGateway } from '@domain/ports/OltProvisioningGateway';
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

/** Fixture BRIDGE — tr069 Disabled, 0 puertos wifi. El caso que separa reboot de wifi. */
const BRIDGE_STATUS: OnuWifiStatus = {
  found: true,
  onuType: 'HG8010H',
  online: true,
  tr069Enabled: false,
  bands: [],
};

/** Fake controlable — permite simular "la ONU desaparece de SmartOLT entre el GET y el POST" (caso 4). */
class FakeWifiManagementPort implements Pick<WifiManagementPort, 'getOnuWifiStatus'> {
  statusBySn = new Map<string, OnuWifiStatus>();
  notConfigured = false;

  async getOnuWifiStatus(sn: string): Promise<OnuWifiStatus> {
    if (this.notConfigured) throw new OltProvisioningError('not_configured', 'SmartOLT no configurado');
    const s = this.statusBySn.get(sn);
    if (!s) return { found: false, onuType: null, online: false, tr069Enabled: false, bands: [] };
    return s;
  }
}

class FakeOltProvisioningGateway implements Pick<OltProvisioningGateway, 'reboot'> {
  rebootCalls: string[] = [];
  /** Simula "SmartOLT falló" — el caso que en prod devolvía 500 mudo (caso 7). */
  failWith: Error | null = null;
  /**
   * Resuelve cuando el reboot DESACOPLADO terminó (ok o error). Deja esperar el
   * evento exacto sin sleeps y SIN depender del log — así el probe del 202 y el
   * probe del logueo fallan por motivos distintos.
   */
  readonly rebootSettled: Promise<void>;
  private readonly settle: () => void;

  constructor() {
    let settle!: () => void;
    this.rebootSettled = new Promise<void>((resolve) => { settle = resolve; });
    this.settle = settle;
  }

  async reboot(sn: string): Promise<void> {
    this.rebootCalls.push(sn);
    try {
      if (this.failWith) throw this.failWith;
    } finally {
      this.settle();
    }
  }
}

/**
 * Logger espía cuyo `error` RESUELVE `logged`: el test espera el evento EXACTO
 * que assertea (el log del fallo desacoplado) — sin sleeps ni conteos de ticks.
 */
function spyLogger() {
  let seen!: () => void;
  const logged = new Promise<void>((resolve) => { seen = resolve; });
  const error = jest.fn((..._args: unknown[]) => { seen(); });
  return { logger: { error } as { error: jest.Mock }, logged };
}

function buildStack(opts?: {
  customers?: Pick<CustomerRepository, 'listContracts'>;
  equipmentRebootLimit?: number;
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
  const equipmentRebootRateLimiter = createPortalEquipmentRebootRateLimiter({
    windowMs: 60_000,
    limit: opts?.equipmentRebootLimit ?? 2,
  });

  const inventory = new InMemoryContractInventoryRepository();
  const wifi = new FakeWifiManagementPort();
  const gateway = new FakeOltProvisioningGateway();
  const customers = opts?.customers ?? fakeCustomers({});

  const resolveEquipmentRebootEligibility = new ResolveEquipmentRebootEligibility(customers, inventory, wifi);
  const getPortalEquipmentStatus = new GetPortalEquipmentStatus(resolveEquipmentRebootEligibility);
  const { logger, logged } = spyLogger();
  const rebootPortalEquipment = new RebootPortalEquipment(resolveEquipmentRebootEligibility, gateway, logger);

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
      getPortalEquipmentStatus,
      rebootPortalEquipment,
      equipmentRebootRateLimiter,
    }),
  );

  return { app, accounts, hasher, inventory, wifi, gateway, logger, logged };
}

async function loginAs(app: express.Express, accounts: InMemoryPortalAccountRepository, hasher: InMemoryPasswordHasher, clientId: string): Promise<string> {
  const dni = `dni-${clientId}`;
  await accounts.create({ clientId, dni, passwordHash: await hasher.hash('Secret123') });
  const res = await request(app).post('/api/portal/auth/login').send({ dni, password: 'Secret123' });
  return res.body.accessToken as string;
}

describe('portal-equipment-reboot — portal /api/portal/equipment', () => {
  it('caso 1 — ONU bridge (tr069 Disabled, 0 puertos wifi) -> eligible:true: ESTE es el caso que separa reboot de wifi', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
    const { app, accounts, hasher, inventory, wifi } = buildStack({ customers });
    const token = await loginAs(app, accounts, hasher, 'client-a');
    await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' }));
    wifi.statusBySn.set('HWTC189C07AA', BRIDGE_STATUS);

    const res = await request(app).get('/api/portal/equipment/c1').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ eligible: true, online: true, model: 'HG8010H' });
  });

  it('caso 2 — sin item ONU -> 200 con reason no_onu (estado NORMAL, no error)', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
    const { app, accounts, hasher } = buildStack({ customers }); // sin item de inventario
    const token = await loginAs(app, accounts, hasher, 'client-a');

    const res = await request(app).get('/api/portal/equipment/c1').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ eligible: false, reason: 'no_onu' });
  });

  it('caso 2 — SmartOLT no configurado -> 200 con reason not_configured', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
    const { app, accounts, hasher, inventory, wifi } = buildStack({ customers });
    const token = await loginAs(app, accounts, hasher, 'client-a');
    await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' }));
    wifi.notConfigured = true;

    const res = await request(app).get('/api/portal/equipment/c1').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ eligible: false, reason: 'not_configured' });
  });

  it('caso 3 (anti-IDOR): GET de un contrato ajeno -> 404, indistinguible de "no existe"', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })], 'client-b': [makeContract({ id: 'c2' })] });
    const { app, accounts, hasher } = buildStack({ customers });
    const token = await loginAs(app, accounts, hasher, 'client-a');

    const resForeign = await request(app).get('/api/portal/equipment/c2').set('Authorization', `Bearer ${token}`);
    const resInexistent = await request(app).get('/api/portal/equipment/no-existe').set('Authorization', `Bearer ${token}`);

    expect(resForeign.status).toBe(404);
    expect(resInexistent.status).toBe(404);
    expect(resForeign.body).toEqual(resInexistent.body);
  });

  it('caso 3 (anti-IDOR): POST /reboot de un contrato ajeno -> 404, indistinguible', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })], 'client-b': [makeContract({ id: 'c2' })] });
    const { app, accounts, hasher } = buildStack({ customers });
    const token = await loginAs(app, accounts, hasher, 'client-a');

    const resForeign = await request(app).post('/api/portal/equipment/c2/reboot').set('Authorization', `Bearer ${token}`);
    const resInexistent = await request(app).post('/api/portal/equipment/no-existe/reboot').set('Authorization', `Bearer ${token}`);

    expect(resForeign.status).toBe(404);
    expect(resInexistent.status).toBe(404);
    expect(resForeign.body).toEqual(resInexistent.body);
  });

  it('caso 4 — POST RE-VERIFICA elegibilidad entera: la ONU desaparece de SmartOLT entre el GET y el POST -> 409, no reinicia', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
    const { app, accounts, hasher, inventory, wifi, gateway } = buildStack({ customers });
    const token = await loginAs(app, accounts, hasher, 'client-a');
    await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' }));
    wifi.statusBySn.set('HWTC189C07AA', BRIDGE_STATUS);

    const getRes = await request(app).get('/api/portal/equipment/c1').set('Authorization', `Bearer ${token}`);
    expect(getRes.body.eligible).toBe(true);

    // Entre el GET y el POST, la ONU desaparece de SmartOLT (found:false).
    wifi.statusBySn.delete('HWTC189C07AA');

    const postRes = await request(app).post('/api/portal/equipment/c1/reboot').set('Authorization', `Bearer ${token}`);

    expect(postRes.status).toBe(409);
    expect(postRes.body).toMatchObject({ code: 'EQUIPMENT_NOT_ELIGIBLE', reason: 'no_onu' });
    expect(gateway.rebootCalls).toHaveLength(0); // NUNCA se disparó el reinicio.
  });

  it('caso 5 — rate limit DURO: el 3ro en la hora -> 429', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
    const { app, accounts, hasher, inventory, wifi } = buildStack({ customers, equipmentRebootLimit: 2 });
    const token = await loginAs(app, accounts, hasher, 'client-a');
    await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' }));
    wifi.statusBySn.set('HWTC189C07AA', BRIDGE_STATUS);

    for (let i = 0; i < 2; i++) {
      const res = await request(app).post('/api/portal/equipment/c1/reboot').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(202);
    }
    const third = await request(app).post('/api/portal/equipment/c1/reboot').set('Authorization', `Bearer ${token}`);
    expect(third.status).toBe(429);
    expect(third.body.code).toBe('RATE_LIMITED');
  });

  it('caso 6 — el POST llama al gateway con la sn NORMALIZADA (hex del item -> ASCII de SmartOLT)', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
    const { app, accounts, hasher, inventory, wifi, gateway } = buildStack({ customers });
    const token = await loginAs(app, accounts, hasher, 'client-a');
    await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' }));
    wifi.statusBySn.set('HWTC189C07AA', BRIDGE_STATUS);

    const res = await request(app).post('/api/portal/equipment/c1/reboot').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });
    expect(gateway.rebootCalls).toEqual(['HWTC189C07AA']);
  });

  // ── reboot ASÍNCRONO (bug reportado en vivo: "Ocurrió un error" en el 1er
  //    intento, ok en el 2do, y CERO líneas en los logs de prod) ────────────────

  it('caso 7 — 202 AUNQUE SmartOLT rechace el reboot: el disparo es desacoplado (antes era 500)', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
    const { app, accounts, hasher, inventory, wifi, gateway } = buildStack({ customers });
    const token = await loginAs(app, accounts, hasher, 'client-a');
    await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' }));
    wifi.statusBySn.set('HWTC189C07AA', BRIDGE_STATUS);
    gateway.failWith = new OltProvisioningError('unreachable', 'timeout of 15000ms exceeded');

    const res = await request(app).post('/api/portal/equipment/c1/reboot').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });
    await gateway.rebootSettled; // el disparo desacoplado ya rechazó — nada quedó colgado
  });

  it('caso 7 — el fallo del reboot desacoplado SE LOGUEA con contractId, sn y el error (sin esto, el próximo reporte vuelve a ser adivinanza)', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
    const { app, accounts, hasher, inventory, wifi, gateway, logger, logged } = buildStack({ customers });
    const token = await loginAs(app, accounts, hasher, 'client-a');
    await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' }));
    wifi.statusBySn.set('HWTC189C07AA', BRIDGE_STATUS);
    gateway.failWith = new OltProvisioningError('unreachable', 'timeout of 15000ms exceeded');

    await request(app).post('/api/portal/equipment/c1/reboot').set('Authorization', `Bearer ${token}`);
    await logged;

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [message, meta] = logger.error.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain('[portal-equipment-reboot]');
    expect(meta).toMatchObject({
      contractId: 'c1',
      sn: 'HWTC189C07AA',
      reason: 'unreachable',
      error: 'timeout of 15000ms exceeded',
    });
  });

  it('caso 7 — un rechazo del gateway NO deja una unhandled rejection (en Node puede voltear el proceso)', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
    const { app, accounts, hasher, inventory, wifi, gateway } = buildStack({ customers });
    const token = await loginAs(app, accounts, hasher, 'client-a');
    await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' }));
    wifi.statusBySn.set('HWTC189C07AA', BRIDGE_STATUS);
    gateway.failWith = new OltProvisioningError('unreachable', 'timeout of 15000ms exceeded');

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      await request(app).post('/api/portal/equipment/c1/reboot').set('Authorization', `Bearer ${token}`);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
