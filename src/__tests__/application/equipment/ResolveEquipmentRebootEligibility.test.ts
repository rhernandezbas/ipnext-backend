/**
 * portal-equipment-reboot — ResolveEquipmentRebootEligibility: la autoridad
 * única de la regla "el reinicio anda incluso en un bridge" (a diferencia de
 * `ResolveWifiEligibility`, que EXIGE tr069Enabled + puertos WiFi). Molde
 * `ResolveWifiEligibility.test.ts`.
 */
import { ResolveEquipmentRebootEligibility } from '@application/use-cases/equipment/ResolveEquipmentRebootEligibility';
import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { ContractInventoryRepository } from '@domain/ports/ContractInventoryRepository';
import type { Contract } from '@domain/entities/customer';
import type { ContractInstalledItem } from '@domain/entities/contract-installed-item';
import type { WifiManagementPort, OnuWifiStatus } from '@domain/ports/WifiManagementPort';
import { EquipmentContractNotFoundError } from '@domain/errors/equipment';
import { OltProvisioningError } from '@domain/errors/smartolt';

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

function fakeCustomers(byClient: Record<string, Contract[]>): Pick<CustomerRepository, 'listContracts'> {
  return { listContracts: async (clientId: string) => byClient[clientId] ?? [] };
}

function fakeInventory(items: ContractInstalledItem[]): Pick<ContractInventoryRepository, 'listByContract'> {
  return { listByContract: async (contractId: string) => items.filter((i) => i.contractId === contractId) };
}

/** Fixture BRIDGE — tr069 Disabled, 0 puertos wifi. El caso que separa reboot de wifi. */
const BRIDGE_STATUS: OnuWifiStatus = {
  found: true,
  onuType: 'HG8010H',
  online: true,
  tr069Enabled: false,
  bands: [],
};

class FakeWifiManagementPort implements Pick<WifiManagementPort, 'getOnuWifiStatus'> {
  statusBySn = new Map<string, OnuWifiStatus>();
  notConfigured = false;

  async getOnuWifiStatus(sn: string): Promise<OnuWifiStatus> {
    if (this.notConfigured) throw new OltProvisioningError('not_configured', 'SmartOLT no configurado');
    const s = this.statusBySn.get(sn);
    if (!s) throw new OltProvisioningError('rejected', 'not found');
    return s;
  }
}

describe('ResolveEquipmentRebootEligibility', () => {
  it('caso 1 — ONU bridge (tr069 Disabled, 0 puertos wifi) -> eligible:true: ESTE es el caso que separa reboot de wifi', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
    const inventory = fakeInventory([makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' })]);
    const wifi = new FakeWifiManagementPort();
    wifi.statusBySn.set('HWTC189C07AA', BRIDGE_STATUS);

    const resolver = new ResolveEquipmentRebootEligibility(customers, inventory, wifi);
    const result = await resolver.execute('client-a', 'c1');

    expect(result).toEqual({ eligible: true, sn: 'HWTC189C07AA', online: true, model: 'HG8010H' });
  });

  it('caso 2 — sin item ONU activo -> reason no_onu', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
    const inventory = fakeInventory([]);
    const wifi = new FakeWifiManagementPort();

    const resolver = new ResolveEquipmentRebootEligibility(customers, inventory, wifi);
    const result = await resolver.execute('client-a', 'c1');

    expect(result).toEqual({ eligible: false, reason: 'no_onu' });
  });

  it('caso 2 — un ROUTER activo NO cuenta como ONU -> reason no_onu', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
    const inventory = fakeInventory([makeItem({ contractId: 'c1', type: 'ROUTER', serialNumber: 'ABC123' })]);
    const wifi = new FakeWifiManagementPort();

    const resolver = new ResolveEquipmentRebootEligibility(customers, inventory, wifi);
    const result = await resolver.execute('client-a', 'c1');

    expect(result).toEqual({ eligible: false, reason: 'no_onu' });
  });

  it('caso 2 — serial no resuelve en SmartOLT (found:false) -> reason no_onu', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
    const inventory = fakeInventory([makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' })]);
    const wifi = new FakeWifiManagementPort();
    // El gateway real ya normaliza "SmartOLT rechazó (serial desconocido)" a
    // found:false — ver el docblock de `getOnuWifiStatus` en SmartOltHttpGateway.
    wifi.statusBySn.set('HWTC189C07AA', { found: false, onuType: null, online: false, tr069Enabled: false, bands: [] });

    const resolver = new ResolveEquipmentRebootEligibility(customers, inventory, wifi);
    const result = await resolver.execute('client-a', 'c1');
    expect(result).toEqual({ eligible: false, reason: 'no_onu' });
  });

  it('SmartOLT no configurado -> reason not_configured', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
    const inventory = fakeInventory([makeItem({ contractId: 'c1', type: 'ONU', serialNumber: '48575443189C07AA' })]);
    const wifi = new FakeWifiManagementPort();
    wifi.notConfigured = true;

    const resolver = new ResolveEquipmentRebootEligibility(customers, inventory, wifi);
    const result = await resolver.execute('client-a', 'c1');

    expect(result).toEqual({ eligible: false, reason: 'not_configured' });
  });

  it('anti-IDOR — contrato ajeno o inexistente -> EquipmentContractNotFoundError', async () => {
    const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })], 'client-b': [makeContract({ id: 'c2' })] });
    const inventory = fakeInventory([]);
    const wifi = new FakeWifiManagementPort();
    const resolver = new ResolveEquipmentRebootEligibility(customers, inventory, wifi);

    await expect(resolver.execute('client-a', 'c2')).rejects.toBeInstanceOf(EquipmentContractNotFoundError);
    await expect(resolver.execute('client-a', 'no-existe')).rejects.toBeInstanceOf(EquipmentContractNotFoundError);
  });
});
