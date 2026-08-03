/**
 * EPIC v3 (wifi de visitas) — `DisablePortalWifiGuest`:
 * `POST /api/portal/wifi/:contractId/guest/disable`. Misma disciplina que
 * `UpdatePortalWifiGuest` (re-verificación ENTERA + banda no disponible ->
 * GuestBandUnavailableError sin tocar el gateway), pero aplica
 * `shutdownWifiPort` (POST onu/shutdown_wifi_port) al puerto de visita.
 */
import { DisablePortalWifiGuest } from '@application/use-cases/wifi/DisablePortalWifiGuest';
import { ResolveWifiEligibility } from '@application/use-cases/wifi/ResolveWifiEligibility';
import { InMemoryOltProvisioningGateway } from '@infrastructure/adapters/in-memory/InMemoryOltProvisioningGateway';
import { InMemoryContractInventoryRepository } from '@infrastructure/adapters/in-memory/InMemoryContractInventoryRepository';
import { GuestBandUnavailableError, WifiContractNotFoundError } from '@domain/errors/wifi';
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

const PORTS_WITH_GUEST_ON: RawWifiPort[] = [
  { port: 'wifi_0/1', ssid: 'Casa', enabled: true },
  { port: 'wifi_0/2', ssid: 'Visitas_Casa', enabled: true },
  { port: 'wifi_0/5', ssid: 'Casa_5G', enabled: true },
  { port: 'wifi_0/6', ssid: null, enabled: false },
];

const TWO_PORTS: RawWifiPort[] = [
  { port: 'wifi_0/1', ssid: 'Luis', enabled: true },
  { port: 'wifi_0/2', ssid: 'Visitas', enabled: true },
];

async function buildStack(opts?: { ports?: RawWifiPort[]; tr069Enabled?: boolean }) {
  const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
  const inventory = new InMemoryContractInventoryRepository();
  await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: RAW_SERIAL }));
  const gw = new InMemoryOltProvisioningGateway();
  gw.wifiOnus.set(SN, { onuType: 'HG8145V5', online: true, tr069Enabled: opts?.tr069Enabled ?? true, ports: opts?.ports ?? PORTS_WITH_GUEST_ON });
  const resolve = new ResolveWifiEligibility(customers, inventory, gw);
  const uc = new DisablePortalWifiGuest(resolve, gw);
  return { uc, gw };
}

describe('DisablePortalWifiGuest', () => {
  it('happy path: shutdownWifiPort al puerto de visita de la banda (wifi_0/2 para 2.4)', async () => {
    const { uc, gw } = await buildStack();

    await uc.execute('client-a', 'c1', '2.4');

    expect(gw.calls).toEqual([{ method: 'shutdownWifiPort', sn: SN, port: 'wifi_0/2' }]);
    // El estado del fake refleja el apagado — el próximo GET ve enabled:false.
    const status = await gw.getOnuWifiStatus(SN);
    expect(status.guest!.find((g) => g.band === '2.4')!.enabled).toBe(false);
  });

  it('banda 5 disponible: shutdownWifiPort a wifi_0/6', async () => {
    const { uc, gw } = await buildStack();
    await uc.execute('client-a', 'c1', '5');
    expect(gw.calls).toEqual([{ method: 'shutdownWifiPort', sn: SN, port: 'wifi_0/6' }]);
  });

  it('banda sin puerto de visita -> GuestBandUnavailableError, gateway JAMÁS llamado', async () => {
    const { uc, gw } = await buildStack({ ports: TWO_PORTS });
    await expect(uc.execute('client-a', 'c1', '5')).rejects.toBeInstanceOf(GuestBandUnavailableError);
    expect(gw.calls).toHaveLength(0);
  });

  it('re-verifica elegibilidad ENTERA: sin TR-069 -> WifiNotEligibleError', async () => {
    const { uc, gw } = await buildStack({ tr069Enabled: false });
    await expect(uc.execute('client-a', 'c1', '2.4')).rejects.toMatchObject({ code: 'WIFI_NOT_ELIGIBLE', reason: 'no_tr069' });
    expect(gw.calls).toHaveLength(0);
  });

  it('anti-IDOR: contrato ajeno/inexistente -> WifiContractNotFoundError', async () => {
    const { uc } = await buildStack();
    await expect(uc.execute('client-a', 'c-ajeno', '2.4')).rejects.toBeInstanceOf(WifiContractNotFoundError);
  });
});
