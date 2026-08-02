/**
 * wifi-self-service (F0) — ResolveWifiEligibility. TDD casos obligatorios #3
 * (un test por reason + caso feliz, fixture no_onu con item de OTRO tipo
 * activo) y #4 (anti-IDOR a nivel use case — el nivel HTTP se cubre en
 * portalWifi.routes.test.ts).
 */
import { ResolveWifiEligibility } from '@application/use-cases/wifi/ResolveWifiEligibility';
import { WifiContractNotFoundError } from '@domain/errors/wifi';
import { OltProvisioningError } from '@domain/errors/smartolt';
import { InMemoryContractInventoryRepository } from '@infrastructure/adapters/in-memory/InMemoryContractInventoryRepository';
import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { WifiManagementPort, OnuWifiStatus } from '@domain/ports/WifiManagementPort';
import type { Contract } from '@domain/entities/customer';
import type { ContractInstalledItem } from '@domain/entities/contract-installed-item';

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

function fakeWifi(statusBySn: Record<string, OnuWifiStatus | OltProvisioningError>): Pick<WifiManagementPort, 'getOnuWifiStatus'> {
  return {
    getOnuWifiStatus: async (sn: string) => {
      const entry = statusBySn[sn];
      if (entry instanceof OltProvisioningError) throw entry;
      if (!entry) throw new Error(`unexpected sn ${sn}`);
      return entry;
    },
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

describe('ResolveWifiEligibility', () => {
  it('caso feliz: ONU activa, encontrada, TR-069 on, con bandas -> eligible:true', async () => {
    const inventory = new InMemoryContractInventoryRepository();
    await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' }));
    const customers = fakeCustomers({ client1: [makeContract({ id: 'c1' })] });
    const wifi = fakeWifi({ HWTC189C07AA: ELIGIBLE_STATUS });

    const uc = new ResolveWifiEligibility(customers, inventory, wifi);
    const result = await uc.execute('client1', 'c1');

    expect(result).toEqual({ eligible: true, sn: 'HWTC189C07AA', bands: ELIGIBLE_STATUS.bands });
  });

  it('reason no_onu: sin ContractInstalledItem ONU activo (un ROUTER activo NO cuenta)', async () => {
    const inventory = new InMemoryContractInventoryRepository();
    await inventory.create(makeItem({ contractId: 'c1', type: 'ROUTER', serialNumber: 'AABBCCDD' }));
    const customers = fakeCustomers({ client1: [makeContract({ id: 'c1' })] });
    const wifi = fakeWifi({});

    const uc = new ResolveWifiEligibility(customers, inventory, wifi);
    const result = await uc.execute('client1', 'c1');

    expect(result).toEqual({ eligible: false, reason: 'no_onu' });
  });

  it('reason no_onu: la ONU normaliza pero SmartOLT no la conoce (found:false)', async () => {
    const inventory = new InMemoryContractInventoryRepository();
    await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' }));
    const customers = fakeCustomers({ client1: [makeContract({ id: 'c1' })] });
    const wifi = fakeWifi({
      HWTC189C07AA: { found: false, onuType: null, online: false, tr069Enabled: false, bands: [] },
    });

    const uc = new ResolveWifiEligibility(customers, inventory, wifi);
    expect(await uc.execute('client1', 'c1')).toEqual({ eligible: false, reason: 'no_onu' });
  });

  it('reason no_tr069: la ONU existe pero TR-069 está deshabilitado', async () => {
    const inventory = new InMemoryContractInventoryRepository();
    await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' }));
    const customers = fakeCustomers({ client1: [makeContract({ id: 'c1' })] });
    const wifi = fakeWifi({ HWTC189C07AA: { ...ELIGIBLE_STATUS, tr069Enabled: false } });

    const uc = new ResolveWifiEligibility(customers, inventory, wifi);
    expect(await uc.execute('client1', 'c1')).toEqual({ eligible: false, reason: 'no_tr069' });
  });

  it('reason no_wifi_ports: TR-069 on pero 0 bandas (bridge)', async () => {
    const inventory = new InMemoryContractInventoryRepository();
    await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' }));
    const customers = fakeCustomers({ client1: [makeContract({ id: 'c1' })] });
    const wifi = fakeWifi({ HWTC189C07AA: { ...ELIGIBLE_STATUS, bands: [] } });

    const uc = new ResolveWifiEligibility(customers, inventory, wifi);
    expect(await uc.execute('client1', 'c1')).toEqual({ eligible: false, reason: 'no_wifi_ports' });
  });

  it('reason not_configured: SmartOLT sin credenciales -> reason limpio, NO explota', async () => {
    const inventory = new InMemoryContractInventoryRepository();
    await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' }));
    const customers = fakeCustomers({ client1: [makeContract({ id: 'c1' })] });
    const wifi = fakeWifi({
      HWTC189C07AA: new OltProvisioningError('not_configured', 'SmartOLT no configurado'),
    });

    const uc = new ResolveWifiEligibility(customers, inventory, wifi);
    expect(await uc.execute('client1', 'c1')).toEqual({ eligible: false, reason: 'not_configured' });
  });

  it('anti-IDOR: contrato de otro cliente (o inexistente) -> WifiContractNotFoundError', async () => {
    const inventory = new InMemoryContractInventoryRepository();
    const customers = fakeCustomers({ client1: [makeContract({ id: 'c1' })] });
    const wifi = fakeWifi({});

    const uc = new ResolveWifiEligibility(customers, inventory, wifi);
    await expect(uc.execute('client1', 'contrato-ajeno')).rejects.toBeInstanceOf(WifiContractNotFoundError);
    await expect(uc.execute('otro-cliente', 'c1')).rejects.toBeInstanceOf(WifiContractNotFoundError);
  });

  it('errores de infraestructura genuinos (unreachable) SÍ propagan, no se disfrazan de reason', async () => {
    const inventory = new InMemoryContractInventoryRepository();
    await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' }));
    const customers = fakeCustomers({ client1: [makeContract({ id: 'c1' })] });
    const wifi = fakeWifi({
      HWTC189C07AA: new OltProvisioningError('unreachable', 'timeout'),
    });

    const uc = new ResolveWifiEligibility(customers, inventory, wifi);
    await expect(uc.execute('client1', 'c1')).rejects.toMatchObject({ reason: 'unreachable' });
  });
});
