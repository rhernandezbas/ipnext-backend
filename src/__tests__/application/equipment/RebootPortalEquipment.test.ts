/**
 * portal-equipment-reboot (async) — RebootPortalEquipment: el disparo del
 * reinicio es DESACOPLADO de la respuesta HTTP.
 *
 * Contexto (bug reportado en vivo): el cliente reinició desde la app, el primer
 * intento le devolvió "Ocurrió un error" y el segundo funcionó. En los logs de
 * prod NO había NADA — SmartOLT falla, el back devuelve 500 y no registra una
 * sola línea. Esa ceguera es parte de lo que arregla este cambio.
 *
 * Lo que estos tests fijan:
 *  1. la ELEGIBILIDAD sigue siendo SÍNCRONA (decide 409/404 — no puede volverse
 *     invisible), y un inelegible NUNCA dispara el reboot;
 *  2. confirmada la elegibilidad, `execute()` RESUELVE sin esperar al
 *     `gateway.reboot(sn)` (202 = aceptado, no = completado);
 *  3. si el reboot desacoplado rechaza, se LOGUEA con contractId + sn + error
 *     (+ el `reason` del `OltProvisioningError` si aplica);
 *  4. ese rechazo NO escapa como unhandled rejection (en Node puede voltear el
 *     proceso).
 */
import { RebootPortalEquipment } from '@application/use-cases/equipment/RebootPortalEquipment';
import { ResolveEquipmentRebootEligibility } from '@application/use-cases/equipment/ResolveEquipmentRebootEligibility';
import { InMemoryOltProvisioningGateway } from '@infrastructure/adapters/in-memory/InMemoryOltProvisioningGateway';
import { InMemoryContractInventoryRepository } from '@infrastructure/adapters/in-memory/InMemoryContractInventoryRepository';
import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { Contract } from '@domain/entities/customer';
import type { ContractInstalledItem } from '@domain/entities/contract-installed-item';
import type { WifiManagementPort, OnuWifiStatus } from '@domain/ports/WifiManagementPort';
import { EquipmentNotEligibleError } from '@domain/errors/equipment';

/** SN hex del item de inventario y su forma normalizada (la que ve SmartOLT). */
const SN_HEX = '48575443189C07AA';
const SN_ASCII = 'HWTC189C07AA';

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

/** ONU bridge: tr069 Disabled, 0 puertos wifi — igual es ELEGIBLE para reboot (OMCI). */
const BRIDGE_STATUS: OnuWifiStatus = {
  found: true,
  onuType: 'HG8010H',
  online: true,
  tr069Enabled: false,
  bands: [],
};

class FakeWifiManagementPort implements Pick<WifiManagementPort, 'getOnuWifiStatus'> {
  statusBySn = new Map<string, OnuWifiStatus>();

  async getOnuWifiStatus(sn: string): Promise<OnuWifiStatus> {
    const s = this.statusBySn.get(sn);
    if (!s) return { found: false, onuType: null, online: false, tr069Enabled: false, bands: [] };
    return s;
  }
}

/**
 * Logger espía cuyo `error` RESUELVE una promesa: así los tests esperan el
 * evento exacto que assertean (el log del fallo desacoplado) en vez de dormir
 * un rato y cruzar los dedos.
 */
function spyLogger() {
  let seen!: () => void;
  const logged = new Promise<void>((resolve) => { seen = resolve; });
  const error = jest.fn((..._args: unknown[]) => { seen(); });
  return { logger: { error } as { error: jest.Mock }, logged };
}

async function buildStack(opts?: { eligible?: boolean }) {
  const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
  const inventory = new InMemoryContractInventoryRepository();
  await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: SN_HEX }));
  const wifi = new FakeWifiManagementPort();
  if (opts?.eligible !== false) wifi.statusBySn.set(SN_ASCII, BRIDGE_STATUS);

  const resolver = new ResolveEquipmentRebootEligibility(customers, inventory, wifi);
  const gateway = new InMemoryOltProvisioningGateway();
  const { logger, logged } = spyLogger();
  const useCase = new RebootPortalEquipment(resolver, gateway, logger);
  return { useCase, gateway, logger, logged };
}

/** Deja correr la cola de microtareas + un turno de macrotarea (sin dormir). */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('RebootPortalEquipment — disparo DESACOPLADO (202 = aceptado, no completado)', () => {
  it('execute() RESUELVE sin esperar al gateway: el reboot queda en vuelo', async () => {
    const { useCase, gateway } = await buildStack();
    // El reboot NUNCA termina: si `execute` lo esperara, este test colgaría.
    let releaseReboot!: () => void;
    jest.spyOn(gateway, 'reboot').mockImplementation(
      () => new Promise<void>((resolve) => { releaseReboot = resolve; }),
    );

    await expect(useCase.execute('client-a', 'c1')).resolves.toBeUndefined();

    releaseReboot();
  });

  it('si el gateway RECHAZA, execute() igual resuelve (el fallo ya no llega al cliente)', async () => {
    const { useCase, gateway } = await buildStack();
    gateway.failMethods = ['reboot'];

    await expect(useCase.execute('client-a', 'c1')).resolves.toBeUndefined();

    await flush(); // que el disparo desacoplado termine ANTES de cerrar el test
  });

  it('el fallo del reboot desacoplado SE LOGUEA con contractId, sn, reason y mensaje', async () => {
    const { useCase, gateway, logger, logged } = await buildStack();
    gateway.failMethods = ['reboot']; // -> OltProvisioningError reason 'rejected'

    await useCase.execute('client-a', 'c1');
    await logged;

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [message, meta] = logger.error.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain('[portal-equipment-reboot]');
    expect(meta).toMatchObject({
      contractId: 'c1',
      sn: SN_ASCII,
      reason: 'rejected',
      error: expect.stringContaining('reboot'),
    });
  });

  it('un rechazo del gateway NO produce unhandled rejection', async () => {
    const { useCase, gateway } = await buildStack();
    gateway.failMethods = ['reboot'];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);

    try {
      await useCase.execute('client-a', 'c1');
      await flush();
      await flush();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('REGLA DURA intacta: inelegible -> EquipmentNotEligibleError y el gateway NUNCA se llama', async () => {
    const { useCase, gateway } = await buildStack({ eligible: false });

    await expect(useCase.execute('client-a', 'c1')).rejects.toBeInstanceOf(EquipmentNotEligibleError);

    await flush();
    expect(gateway.calls).toHaveLength(0);
  });
});
