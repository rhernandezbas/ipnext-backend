/**
 * EPIC v3 (wifi de visitas) — `UpdatePortalWifiGuest`: `PUT /api/portal/wifi/:contractId/guest`.
 * Molde `UpdatePortalWifiBand` (regla dura: re-verifica la elegibilidad ENTERA en cada
 * escritura) + la regla NUEVA: banda cuyo puerto de visita NO figura en el template ->
 * `GuestBandUnavailableError` (409) y el gateway JAMÁS se toca.
 *
 * Fakes: `InMemoryOltProvisioningGateway` extendido con estado de puertos WiFi
 * (`wifiOnus`) — deriva bands/guest con las MISMAS funciones de dominio que el
 * adapter real. JAMÁS SmartOLT real.
 */
import { UpdatePortalWifiGuest } from '@application/use-cases/wifi/UpdatePortalWifiGuest';
import { ResolveWifiEligibility } from '@application/use-cases/wifi/ResolveWifiEligibility';
import { InMemoryOltProvisioningGateway } from '@infrastructure/adapters/in-memory/InMemoryOltProvisioningGateway';
import { InMemoryContractInventoryRepository } from '@infrastructure/adapters/in-memory/InMemoryContractInventoryRepository';
import { InMemoryOnuWifiCredentialRepository } from '@infrastructure/adapters/in-memory/InMemoryOnuWifiCredentialRepository';
import { InMemoryWifiGuestIntentRepository } from '@infrastructure/adapters/in-memory/InMemoryWifiGuestIntentRepository';
import { GuestBandUnavailableError, GuestChangePendingError, WifiContractNotFoundError, WifiNotEligibleError, WifiValidationError } from '@domain/errors/wifi';
import { OltProvisioningError } from '@domain/errors/smartolt';
import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { Contract } from '@domain/entities/customer';
import type { ContractInstalledItem } from '@domain/entities/contract-installed-item';
import type { RawWifiPort } from '@domain/services/mapWifiPortsToBands';

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

/** Template completo (8 puertos): visita disponible en ambas bandas. */
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

/** Template real HWTCA92F96B1 (2026-08-03): SOLO wifi_0/1..2 — banda 5 SIN puerto de visita. */
const TWO_PORTS: RawWifiPort[] = [
  { port: 'wifi_0/1', ssid: 'Luis', enabled: true },
  { port: 'wifi_0/2', ssid: null, enabled: false },
];

/** Reloj fijo del suite (wifi-guest-pending) — la edad del intent se controla con `since` relativo a T0. */
const T0 = Date.parse('2026-08-05T12:00:00.000Z');
const T0_ISO = '2026-08-05T12:00:00.000Z';
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

async function buildStack(opts?: { ports?: RawWifiPort[]; tr069Enabled?: boolean }) {
  const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
  const inventory = new InMemoryContractInventoryRepository();
  await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: RAW_SERIAL }));
  const gw = new InMemoryOltProvisioningGateway();
  gw.wifiOnus.set(SN, { onuType: 'HG8145V5', online: true, tr069Enabled: opts?.tr069Enabled ?? true, ports: opts?.ports ?? EIGHT_PORTS });
  const credentials = new InMemoryOnuWifiCredentialRepository();
  const intents = new InMemoryWifiGuestIntentRepository();
  const resolve = new ResolveWifiEligibility(customers, inventory, gw);
  const uc = new UpdatePortalWifiGuest(resolve, gw, credentials, intents, () => T0);
  return { uc, gw, credentials, intents };
}

describe('UpdatePortalWifiGuest', () => {
  it('happy path: aplica set al PUERTO DE VISITA de la banda (wifi_0/2 para 2.4)', async () => {
    const { uc, gw } = await buildStack();

    await uc.execute('client-a', 'c1', { band: '2.4', ssid: 'Visitas_Casa', password: 'clave1234' });

    expect(gw.calls).toEqual([
      { method: 'setWifiBand', sn: SN, input: { port: 'wifi_0/2', ssid: 'Visitas_Casa', password: 'clave1234' } },
    ]);
  });

  it('banda 5: aplica a wifi_0/6', async () => {
    const { uc, gw } = await buildStack();
    await uc.execute('client-a', 'c1', { band: '5', ssid: 'Visitas_5G', password: 'clave1234' });
    expect(gw.calls).toEqual([
      { method: 'setWifiBand', sn: SN, input: { port: 'wifi_0/6', ssid: 'Visitas_5G', password: 'clave1234' } },
    ]);
  });

  it('REGLA NUEVA: banda sin puerto de visita en el template -> GuestBandUnavailableError y el gateway NUNCA se llama', async () => {
    const { uc, gw } = await buildStack({ ports: TWO_PORTS });

    await expect(uc.execute('client-a', 'c1', { band: '5', ssid: 'Visitas', password: 'clave1234' }))
      .rejects.toBeInstanceOf(GuestBandUnavailableError);
    expect(gw.calls.filter((c) => c.method === 'setWifiBand')).toHaveLength(0);
  });

  it('re-verifica elegibilidad ENTERA: sin TR-069 -> WifiNotEligibleError, sin tocar el gateway', async () => {
    const { uc, gw } = await buildStack({ tr069Enabled: false });
    await expect(uc.execute('client-a', 'c1', { band: '2.4', ssid: 'Visitas', password: 'clave1234' }))
      .rejects.toMatchObject({ code: 'WIFI_NOT_ELIGIBLE', reason: 'no_tr069' });
    expect(gw.calls.filter((c) => c.method === 'setWifiBand')).toHaveLength(0);
  });

  it('anti-IDOR: contrato ajeno/inexistente -> WifiContractNotFoundError', async () => {
    const { uc } = await buildStack();
    await expect(uc.execute('client-a', 'c-ajeno', { band: '2.4', ssid: 'X', password: 'clave1234' }))
      .rejects.toBeInstanceOf(WifiContractNotFoundError);
  });

  it('validación de forma ANTES de resolver: password corta -> WifiValidationError', async () => {
    const { uc, gw } = await buildStack();
    await expect(uc.execute('client-a', 'c1', { band: '2.4', ssid: 'X', password: '1234567' }))
      .rejects.toBeInstanceOf(WifiValidationError);
    expect(gw.calls).toHaveLength(0);
  });

  it('snapshot de password (wifi-password-snapshot): upsert con updatedBy portal, mismo criterio que el PUT principal', async () => {
    const { uc, credentials } = await buildStack();
    await uc.execute('client-a', 'c1', { band: '2.4', ssid: 'Visitas_Casa', password: 'clave1234' });
    const saved = credentials.all().find((c) => c.sn === SN && c.port === 'wifi_0/2');
    expect(saved).toMatchObject({ ssid: 'Visitas_Casa', password: 'clave1234', updatedBy: 'portal' });
  });

  it('snapshot falla -> NO tumba la escritura (el equipo ya cambió)', async () => {
    const { uc, gw, credentials } = await buildStack();
    credentials.upsert = async () => { throw new Error('DB caída (simulado)'); };
    await expect(uc.execute('client-a', 'c1', { band: '2.4', ssid: 'V', password: 'clave1234' }))
      .resolves.toMatchObject({ action: 'creating', status: 'in_progress' });
    expect(gw.calls.filter((c) => c.method === 'setWifiBand')).toHaveLength(1);
  });
});

describe('UpdatePortalWifiGuest — estado PENDIENTE (wifi-guest-pending)', () => {
  it('happy path: devuelve guestPending creating/in_progress y PERSISTE el intent (sobrevive restarts)', async () => {
    const { uc, intents } = await buildStack();

    const result = await uc.execute('client-a', 'c1', { band: '2.4', ssid: 'Visitas_Casa', password: 'clave1234' });

    expect(result).toEqual({ action: 'creating', since: T0_ISO, status: 'in_progress' });
    expect(intents.all()).toEqual([
      expect.objectContaining({ sn: SN, action: 'creating', port: 'wifi_0/2', since: T0_ISO, retriedAt: null }),
    ]);
  });

  it('409 en pending: intent en curso (< 10 min) -> GuestChangePendingError, el gateway JAMÁS se toca y el intent NO cambia', async () => {
    const { uc, gw, intents } = await buildStack();
    await intents.replace({ sn: SN, contractId: 'c1', action: 'deleting', port: 'wifi_0/2', since: iso(T0 - 5 * MIN) });

    await expect(uc.execute('client-a', 'c1', { band: '2.4', ssid: 'Visitas', password: 'clave1234' }))
      .rejects.toBeInstanceOf(GuestChangePendingError);

    expect(gw.calls).toHaveLength(0);
    expect(intents.all()).toEqual([
      expect.objectContaining({ action: 'deleting', since: iso(T0 - 5 * MIN) }),
    ]);
  });

  it('intent con >= 10 min (unconfirmed/expirado) PERMITE reintentar: escribe y lo REEMPLAZA por uno nuevo', async () => {
    const { uc, gw, intents } = await buildStack();
    await intents.replace({ sn: SN, contractId: 'c1', action: 'deleting', port: 'wifi_0/2', since: iso(T0 - 10 * MIN) });

    const result = await uc.execute('client-a', 'c1', { band: '2.4', ssid: 'Visitas', password: 'clave1234' });

    expect(result).toMatchObject({ action: 'creating', since: T0_ISO, status: 'in_progress' });
    expect(gw.calls.filter((c) => c.method === 'setWifiBand')).toHaveLength(1);
    expect(intents.all()).toEqual([
      expect.objectContaining({ action: 'creating', since: T0_ISO, retriedAt: null }),
    ]);
  });

  it('intent en curso pero de OTRO contrato (ONT re-provisionado) -> NO 409: el write procede y el intent huérfano se REEMPLAZA', async () => {
    const { uc, gw, intents } = await buildStack();
    await intents.replace({ sn: SN, contractId: 'c-dueno-anterior', action: 'deleting', port: 'wifi_0/2', since: iso(T0 - 2 * MIN) });

    const result = await uc.execute('client-a', 'c1', { band: '2.4', ssid: 'Visitas', password: 'clave1234' });

    expect(result).toMatchObject({ action: 'creating', status: 'in_progress' });
    expect(gw.calls.filter((c) => c.method === 'setWifiBand')).toHaveLength(1);
    expect(intents.all()).toEqual([
      expect.objectContaining({ contractId: 'c1', action: 'creating', since: T0_ISO }),
    ]);
  });

  it('SmartOLT rechaza el write -> el error propaga COMO HOY y NO se crea intent', async () => {
    const { uc, gw, intents } = await buildStack();
    gw.failWifiPorts = ['wifi_0/2'];

    await expect(uc.execute('client-a', 'c1', { band: '2.4', ssid: 'Visitas', password: 'clave1234' }))
      .rejects.toBeInstanceOf(OltProvisioningError);
    expect(intents.all()).toHaveLength(0);
  });
});
