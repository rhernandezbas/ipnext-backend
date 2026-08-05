/**
 * wifi-guest-pending — evaluación LAZY del intent en `GetPortalWifiStatus`
 * (sin cron): cada GET del portal con un intent activo decide entre
 * 'in_progress' / re-push / 'unconfirmed' / cerrar el intent.
 *
 * Reglas (contrato FIJO con la app — ver prompt del change):
 *  - edad < 10 min  -> 'in_progress'. Si action='deleting' Y edad > 3 min Y
 *    sin retriedAt: verificar contra la lectura VIVA (`getOnlineWifiMacs`);
 *    si el índice WLAN del puerto guest SIGUE con MACs -> re-push
 *    `shutdown_wifi_port` UNA vez y sellar retriedAt.
 *  - edad >= 10 min -> deleting: MACs siguen -> 'unconfirmed' (intent se
 *    MANTIENE, no más retries); sin MACs -> borrar intent (señal asimétrica:
 *    "sin MACs" no PRUEBA radio apagada, pero es la única señal viva).
 *    creating: borrar intent (la DB de SmartOLT ya refleja el alta).
 *  - la verificación que falle NO rompe el GET: degrada según edad.
 *
 * Fakes in-memory SIEMPRE (regla del repo) — jamás SmartOLT real.
 */
import { GetPortalWifiStatus } from '@application/use-cases/wifi/GetPortalWifiStatus';
import { ResolveWifiEligibility } from '@application/use-cases/wifi/ResolveWifiEligibility';
import { InMemoryOltProvisioningGateway } from '@infrastructure/adapters/in-memory/InMemoryOltProvisioningGateway';
import { InMemoryContractInventoryRepository } from '@infrastructure/adapters/in-memory/InMemoryContractInventoryRepository';
import { InMemoryOnuWifiCredentialRepository } from '@infrastructure/adapters/in-memory/InMemoryOnuWifiCredentialRepository';
import { InMemoryWifiGuestIntentRepository } from '@infrastructure/adapters/in-memory/InMemoryWifiGuestIntentRepository';
import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { Contract } from '@domain/entities/customer';
import type { ContractInstalledItem } from '@domain/entities/contract-installed-item';
import type { RawWifiPort } from '@domain/services/mapWifiPortsToBands';

const SN = 'HWTC189C07AA';
const RAW_SERIAL = '48575443189C07AA';

const T0 = Date.parse('2026-08-05T12:00:00.000Z');
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

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

async function buildStack() {
  const customers = fakeCustomers({ 'client-a': [makeContract({ id: 'c1' })] });
  const inventory = new InMemoryContractInventoryRepository();
  await inventory.create(makeItem({ contractId: 'c1', type: 'ONU', serialNumber: RAW_SERIAL }));
  const gw = new InMemoryOltProvisioningGateway();
  gw.wifiOnus.set(SN, { onuType: 'HG8145V5', online: true, tr069Enabled: true, ports: EIGHT_PORTS });
  const credentials = new InMemoryOnuWifiCredentialRepository();
  const intents = new InMemoryWifiGuestIntentRepository();
  const resolve = new ResolveWifiEligibility(customers, inventory, gw);
  let nowMs = T0;
  const uc = new GetPortalWifiStatus(resolve, gw, credentials, intents, () => nowMs);
  return { uc, gw, intents, setNow: (ms: number) => { nowMs = ms; } };
}

function shutdownCalls(gw: InMemoryOltProvisioningGateway) {
  return gw.calls.filter((c) => c.method === 'shutdownWifiPort');
}

function verifyCalls(gw: InMemoryOltProvisioningGateway) {
  return gw.calls.filter((c) => c.method === 'getOnlineWifiMacs');
}

describe('GetPortalWifiStatus — guestPending (evaluación lazy del intent)', () => {
  it('sin intent -> el campo guestPending NO está (contrato aditivo)', async () => {
    const { uc } = await buildStack();
    const res = await uc.execute('client-a', 'c1');
    expect(res).not.toHaveProperty('guestPending');
  });

  it('intent HUÉRFANO (el ONT se re-provisionó a OTRO contrato) -> se borra en silencio, sin guestPending y SIN verificación (el dueño nuevo no hereda el nag)', async () => {
    const { uc, gw, intents } = await buildStack();
    // Intent viejo del contrato anterior, en la ventana que más molestaría (>= 10 min, deleting con MACs vivas -> daría unconfirmed).
    await intents.replace({ sn: SN, contractId: 'c-dueno-anterior', action: 'deleting', port: 'wifi_0/2', since: iso(T0 - 15 * MIN) });
    gw.onlineWifiMacsBySn.set(SN, [{ wlanIndex: 2, mac: '1e:be:33:9b:97:b2' }]);

    const res = await uc.execute('client-a', 'c1');

    expect(res).not.toHaveProperty('guestPending');
    expect(intents.all()).toHaveLength(0);
    expect(verifyCalls(gw)).toHaveLength(0);
    expect(shutdownCalls(gw)).toHaveLength(0);
  });

  describe("action='creating'", () => {
    it('edad < 10 min -> in_progress, SIN verificación (la lectura viva no se gasta en altas)', async () => {
      const { uc, gw, intents } = await buildStack();
      await intents.replace({ sn: SN, contractId: 'c1', action: 'creating', port: 'wifi_0/2', since: iso(T0 - 2 * MIN) });

      const res = await uc.execute('client-a', 'c1');

      expect(res).toMatchObject({
        guestPending: { action: 'creating', since: iso(T0 - 2 * MIN), status: 'in_progress' },
      });
      expect(verifyCalls(gw)).toHaveLength(0);
    });

    it('edad >= 10 min -> intent BORRADO y sin guestPending (la DB de SmartOLT ya refleja el alta; pending del alta = UX temporal)', async () => {
      const { uc, gw, intents } = await buildStack();
      await intents.replace({ sn: SN, contractId: 'c1', action: 'creating', port: 'wifi_0/2', since: iso(T0 - 10 * MIN) });

      const res = await uc.execute('client-a', 'c1');

      expect(res).not.toHaveProperty('guestPending');
      expect(intents.all()).toHaveLength(0);
      expect(verifyCalls(gw)).toHaveLength(0);
    });
  });

  describe("action='deleting', edad < 10 min", () => {
    it('edad <= 3 min -> in_progress SIN verificar ni re-pushear (ventana de gracia del TR-069)', async () => {
      const { uc, gw, intents } = await buildStack();
      await intents.replace({ sn: SN, contractId: 'c1', action: 'deleting', port: 'wifi_0/2', since: iso(T0 - 2 * MIN) });
      gw.onlineWifiMacsBySn.set(SN, [{ wlanIndex: 2, mac: '1e:be:33:9b:97:b2' }]);

      const res = await uc.execute('client-a', 'c1');

      expect(res).toMatchObject({ guestPending: { action: 'deleting', status: 'in_progress' } });
      expect(verifyCalls(gw)).toHaveLength(0);
      expect(shutdownCalls(gw)).toHaveLength(0);
    });

    it('re-push a los 3 min: edad > 3 min, sin retriedAt y MACs SIGUEN en el índice guest -> re-push UNA vez + retriedAt sellado', async () => {
      const { uc, gw, intents } = await buildStack();
      await intents.replace({ sn: SN, contractId: 'c1', action: 'deleting', port: 'wifi_0/2', since: iso(T0 - 4 * MIN) });
      // La radio sigue al aire: MAC online en WLAN 2 (= wifi_0/2), el caso real HWTCA92F96B1.
      gw.onlineWifiMacsBySn.set(SN, [{ wlanIndex: 2, mac: '1e:be:33:9b:97:b2' }]);

      const res = await uc.execute('client-a', 'c1');

      expect(res).toMatchObject({ guestPending: { action: 'deleting', status: 'in_progress' } });
      expect(shutdownCalls(gw)).toEqual([{ method: 'shutdownWifiPort', sn: SN, port: 'wifi_0/2' }]);
      expect((await intents.findBySn(SN))!.retriedAt).toBe(iso(T0));
    });

    it('re-push es UNA sola vez: el 2do GET (retriedAt ya sellado) NO vuelve a pushear ni verificar', async () => {
      const { uc, gw, intents, setNow } = await buildStack();
      await intents.replace({ sn: SN, contractId: 'c1', action: 'deleting', port: 'wifi_0/2', since: iso(T0 - 4 * MIN) });
      gw.onlineWifiMacsBySn.set(SN, [{ wlanIndex: 2, mac: '1e:be:33:9b:97:b2' }]);

      await uc.execute('client-a', 'c1');
      setNow(T0 + 2 * MIN); // edad 6 min, todavía < 10
      const res = await uc.execute('client-a', 'c1');

      expect(res).toMatchObject({ guestPending: { action: 'deleting', status: 'in_progress' } });
      expect(shutdownCalls(gw)).toHaveLength(1);
      expect(verifyCalls(gw)).toHaveLength(1);
    });

    it('asimetría de índice: MACs online SOLO en otros WLAN (1 y 5) -> NO re-push (la señal es POR índice guest)', async () => {
      const { uc, gw, intents } = await buildStack();
      await intents.replace({ sn: SN, contractId: 'c1', action: 'deleting', port: 'wifi_0/2', since: iso(T0 - 4 * MIN) });
      gw.onlineWifiMacsBySn.set(SN, [
        { wlanIndex: 1, mac: 'f8:16:0c:31:fc:16' },
        { wlanIndex: 5, mac: 'da:88:d8:52:85:0e' },
      ]);

      const res = await uc.execute('client-a', 'c1');

      expect(res).toMatchObject({ guestPending: { action: 'deleting', status: 'in_progress' } });
      expect(shutdownCalls(gw)).toHaveLength(0);
      expect((await intents.findBySn(SN))!.retriedAt).toBeNull();
    });

    it('banda 5 (wifi_0/6): la verificación mira WLAN 6 — MAC en WLAN 2 NO dispara el re-push', async () => {
      const { uc, gw, intents } = await buildStack();
      await intents.replace({ sn: SN, contractId: 'c1', action: 'deleting', port: 'wifi_0/6', since: iso(T0 - 4 * MIN) });
      gw.onlineWifiMacsBySn.set(SN, [{ wlanIndex: 2, mac: '1e:be:33:9b:97:b2' }]);

      await uc.execute('client-a', 'c1');
      expect(shutdownCalls(gw)).toHaveLength(0);

      gw.onlineWifiMacsBySn.set(SN, [{ wlanIndex: 6, mac: 'aa:bb:cc:dd:ee:ff' }]);
      const { uc: uc2, gw: gw2, intents: intents2 } = await buildStack();
      await intents2.replace({ sn: SN, contractId: 'c1', action: 'deleting', port: 'wifi_0/6', since: iso(T0 - 4 * MIN) });
      gw2.onlineWifiMacsBySn.set(SN, [{ wlanIndex: 6, mac: 'aa:bb:cc:dd:ee:ff' }]);
      await uc2.execute('client-a', 'c1');
      expect(shutdownCalls(gw2)).toEqual([{ method: 'shutdownWifiPort', sn: SN, port: 'wifi_0/6' }]);
    });

    it('at-most-once: retriedAt se sella ANTES del push — push falla pero el sello queda, y los GETs siguientes NO verifican ni re-pushean', async () => {
      const { uc, gw, intents } = await buildStack();
      await intents.replace({ sn: SN, contractId: 'c1', action: 'deleting', port: 'wifi_0/2', since: iso(T0 - 4 * MIN) });
      gw.onlineWifiMacsBySn.set(SN, [{ wlanIndex: 2, mac: '1e:be:33:9b:97:b2' }]);
      gw.failMethods = ['shutdownWifiPort'];

      const res = await uc.execute('client-a', 'c1');

      // El GET no rompe y el sello quedó puesto AUNQUE el push falló.
      expect(res).toMatchObject({ guestPending: { action: 'deleting', status: 'in_progress' } });
      expect((await intents.findBySn(SN))!.retriedAt).toBe(iso(T0));

      // Poll de 30s dentro de la ventana: NINGÚN GET posterior vuelve a
      // verificar ni a pushear (sin el sello previo serían ~14 POSTs).
      await uc.execute('client-a', 'c1');
      await uc.execute('client-a', 'c1');
      expect(verifyCalls(gw)).toHaveLength(1);
      expect(shutdownCalls(gw)).toHaveLength(0); // el push fallido jamás se registró ni se reintentó
    });

    it('si el SELLO (markRetried) falla, el push NI SE INTENTA — nunca un push sin sellar, nunca tormenta', async () => {
      const { uc, gw, intents } = await buildStack();
      await intents.replace({ sn: SN, contractId: 'c1', action: 'deleting', port: 'wifi_0/2', since: iso(T0 - 4 * MIN) });
      gw.onlineWifiMacsBySn.set(SN, [{ wlanIndex: 2, mac: '1e:be:33:9b:97:b2' }]);
      intents.markRetried = async () => { throw new Error('DB blip (simulado)'); };

      const res = await uc.execute('client-a', 'c1');

      expect(res).toMatchObject({ guestPending: { action: 'deleting', status: 'in_progress' } });
      expect(shutdownCalls(gw)).toHaveLength(0);
    });

    it('SmartOLT caído en la verificación -> el GET NO rompe: in_progress, sin re-push, retriedAt sigue null', async () => {
      const { uc, gw, intents } = await buildStack();
      await intents.replace({ sn: SN, contractId: 'c1', action: 'deleting', port: 'wifi_0/2', since: iso(T0 - 4 * MIN) });
      gw.failOnlineWifiMacs = true;

      const res = await uc.execute('client-a', 'c1');

      expect(res).toMatchObject({ guestPending: { action: 'deleting', status: 'in_progress' } });
      expect(shutdownCalls(gw)).toHaveLength(0);
      expect((await intents.findBySn(SN))!.retriedAt).toBeNull();
    });
  });

  describe("action='deleting', edad >= 10 min", () => {
    it('unconfirmed a los 10: MACs SIGUEN en el índice guest -> status unconfirmed, intent SE MANTIENE y NO hay re-push (aunque nunca se haya reintentado)', async () => {
      const { uc, gw, intents } = await buildStack();
      await intents.replace({ sn: SN, contractId: 'c1', action: 'deleting', port: 'wifi_0/2', since: iso(T0 - 10 * MIN) });
      gw.onlineWifiMacsBySn.set(SN, [{ wlanIndex: 2, mac: '1e:be:33:9b:97:b2' }]);

      const res = await uc.execute('client-a', 'c1');

      expect(res).toMatchObject({
        guestPending: { action: 'deleting', since: iso(T0 - 10 * MIN), status: 'unconfirmed' },
      });
      expect(intents.all()).toHaveLength(1);
      expect(shutdownCalls(gw)).toHaveLength(0);
    });

    it('asimetría: sin MACs en el índice guest -> intent BORRADO y sin guestPending (asumimos aplicado)', async () => {
      const { uc, gw, intents } = await buildStack();
      await intents.replace({ sn: SN, contractId: 'c1', action: 'deleting', port: 'wifi_0/2', since: iso(T0 - 15 * MIN) });
      gw.onlineWifiMacsBySn.set(SN, [{ wlanIndex: 1, mac: 'f8:16:0c:31:fc:16' }]);

      const res = await uc.execute('client-a', 'c1');

      expect(res).not.toHaveProperty('guestPending');
      expect(intents.all()).toHaveLength(0);
    });

    it('SmartOLT caído en la verificación -> unconfirmed SIN romper el GET, intent se mantiene', async () => {
      const { uc, gw, intents } = await buildStack();
      await intents.replace({ sn: SN, contractId: 'c1', action: 'deleting', port: 'wifi_0/2', since: iso(T0 - 10 * MIN) });
      gw.failOnlineWifiMacs = true;

      const res = await uc.execute('client-a', 'c1');

      expect(res).toMatchObject({ guestPending: { action: 'deleting', status: 'unconfirmed' } });
      expect(intents.all()).toHaveLength(1);
    });
  });
});
