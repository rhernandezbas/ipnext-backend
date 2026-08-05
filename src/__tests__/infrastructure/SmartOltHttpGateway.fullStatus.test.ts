/**
 * wifi-guest-pending — `SmartOltHttpGateway.getOnlineWifiMacs`:
 * GET onu/get_onu_full_status_info/<sn> → "Online MACs on this ONU". Es la
 * ÚNICA lectura VIVA del ONT (get_onu_details es la DB de SmartOLT y MIENTE —
 * evidencia 2026-08-04/05: wifi_0/2 "Disabled" con la red EMITIENDO y clientes
 * conectados). Mismo transport fake que `SmartOltHttpGateway.wifi.test.ts` —
 * REGLA DURA: jamás se toca ipnext.smartolt.com desde tests.
 *
 * ✅ SHAPE VERIFICADO CONTRA EL PAYLOAD REAL (GET en vivo 2026-08-05, ONU
 * HWTCA92F96B1): wrapper `full_status_json` (además del texto crudo en
 * `full_status_info`), sección `"Online MACs on this ONU"` como OBJETO indexado
 * por string (no array), filas `{ Port: 'WLAN 2' | 'ETH 1', 'MAC address':
 * '..', VLAN: '-' }`. "WLAN N" = SSID index N (nota literal del payload); las
 * filas ETH no son WiFi y se descartan.
 */
import { SmartOltHttpGateway } from '@infrastructure/adapters/smartolt/SmartOltHttpGateway';
import { OltProvisioningError } from '@domain/errors/smartolt';
import type { AxiosInstance } from 'axios';

interface RecordedCall {
  method: 'get' | 'post';
  url: string;
  body?: unknown;
  headers?: Record<string, unknown>;
}

class FakeTransport {
  calls: RecordedCall[] = [];
  responses = new Map<string, unknown>();
  errors = new Map<string, unknown>();

  private match<T>(map: Map<string, T>, url: string): T | undefined {
    for (const [prefix, value] of map) {
      if (url.startsWith(prefix)) return value;
    }
    return undefined;
  }

  async get(url: string, config?: { headers?: Record<string, unknown> }): Promise<{ data: unknown }> {
    this.calls.push({ method: 'get', url, headers: config?.headers });
    const err = this.match(this.errors, url);
    if (err) throw err;
    return { data: this.match(this.responses, url) ?? { status: true } };
  }

  async post(url: string, body?: unknown, config?: { headers?: Record<string, unknown> }): Promise<{ data: unknown }> {
    this.calls.push({ method: 'post', url, body, headers: config?.headers });
    const err = this.match(this.errors, url);
    if (err) throw err;
    return { data: this.match(this.responses, url) ?? { status: true } };
  }

  asAxios(): AxiosInstance {
    return this as unknown as AxiosInstance;
  }
}

function buildGateway(opts?: { baseUrl?: string; token?: string }) {
  const transport = new FakeTransport();
  let currentTime = 0;
  const gateway = new SmartOltHttpGateway({
    baseUrl: opts?.baseUrl ?? 'https://ipnext.example/api',
    token: opts?.token ?? 'tok-123',
    stepPauseMs: 0,
    http: transport.asAxios(),
    sleep: async () => {},
    now: () => currentTime,
  });
  return { gateway, transport, advance: (ms: number) => { currentTime += ms; } };
}

// PAYLOAD REAL (GET en vivo 2026-08-05, HWTCA92F96B1) recortado a la sección
// que el mapper consume + el ruido hermano (History, texto crudo). WLAN 2 =
// la red de visitas 2.4 TODAVÍA emitiendo tras el shutdown perdido.
const RAW_FULL_STATUS = {
  full_status_info: 'Optical status\n...texto crudo...\nOnline MACs on this ONU\n...',
  full_status_json: {
    'ONU details': { 'Run state': 'online', SN: '48575443A92F96B1 (HWTC-A92F96B1)' },
    'Online MACs on this ONU': {
      '1': { Port: 'ETH 1', 'MAC address': '24:4b:fe:8e:45:95', VLAN: '4095' },
      '2': { Port: 'ETH 2', 'MAC address': 'ec:b5:fa:a8:fb:07', VLAN: '4095' },
      '3': { Port: 'WLAN 1', 'MAC address': 'f8:16:0c:31:fc:16', VLAN: '-' },
      '4': { Port: 'WLAN 1', 'MAC address': 'c0:91:b9:2c:ad:eb', VLAN: '-' },
      '5': { Port: 'WLAN 2', 'MAC address': '1e:be:33:9b:97:b2', VLAN: '-' },
      '6': { Port: 'WLAN 5', 'MAC address': 'da:88:d8:52:85:0e', VLAN: '-' },
    },
  },
  status: true,
  response_code: 'success',
};

describe('SmartOltHttpGateway — getOnlineWifiMacs', () => {
  it('GET onu/get_onu_full_status_info/<sn> con X-Token; devuelve SOLO las filas WLAN con su índice', async () => {
    const { gateway, transport } = buildGateway();
    transport.responses.set('onu/get_onu_full_status_info/HWTCA92F96B1', RAW_FULL_STATUS);

    const macs = await gateway.getOnlineWifiMacs('HWTCA92F96B1');

    expect(transport.calls[0]).toMatchObject({
      method: 'get',
      url: 'onu/get_onu_full_status_info/HWTCA92F96B1',
      headers: { 'X-Token': 'tok-123' },
    });
    expect(macs).toEqual([
      { wlanIndex: 1, mac: 'f8:16:0c:31:fc:16' },
      { wlanIndex: 1, mac: 'c0:91:b9:2c:ad:eb' },
      { wlanIndex: 2, mac: '1e:be:33:9b:97:b2' },
      { wlanIndex: 5, mac: 'da:88:d8:52:85:0e' },
    ]);
  });

  it('sección "Online MACs on this ONU" ausente (sin clientes) -> []', async () => {
    const { gateway, transport } = buildGateway();
    transport.responses.set('onu/get_onu_full_status_info/HWTC1', {
      full_status_json: { 'ONU details': { 'Run state': 'online' } },
      status: true,
      response_code: 'success',
    });

    expect(await gateway.getOnlineWifiMacs('HWTC1')).toEqual([]);
  });

  it('cache 60s por sn (rate limit 1000/h): 2do call dentro del TTL NO pega a la red; expirado re-fetchea', async () => {
    const { gateway, transport, advance } = buildGateway();
    transport.responses.set('onu/get_onu_full_status_info/HWTCA92F96B1', RAW_FULL_STATUS);

    await gateway.getOnlineWifiMacs('HWTCA92F96B1');
    advance(59_000);
    await gateway.getOnlineWifiMacs('HWTCA92F96B1');
    expect(transport.calls).toHaveLength(1);

    advance(2_000);
    await gateway.getOnlineWifiMacs('HWTCA92F96B1');
    expect(transport.calls).toHaveLength(2);
  });

  it('sin baseUrl/token -> not_configured ANTES de tocar la red', async () => {
    const { gateway, transport } = buildGateway({ baseUrl: '', token: '' });

    await expect(gateway.getOnlineWifiMacs('HWTC1')).rejects.toMatchObject({ reason: 'not_configured' });
    expect(transport.calls).toHaveLength(0);
  });

  it('falla de red -> OltProvisioningError unreachable (propaga, NO se cachea)', async () => {
    const { gateway, transport } = buildGateway();
    transport.errors.set('onu/get_onu_full_status_info/HWTC1', new Error('ETIMEDOUT'));

    await expect(gateway.getOnlineWifiMacs('HWTC1')).rejects.toBeInstanceOf(OltProvisioningError);

    // El error NO quedó cacheado: el próximo call vuelve a intentar.
    transport.errors.clear();
    transport.responses.set('onu/get_onu_full_status_info/HWTC1', RAW_FULL_STATUS);
    await expect(gateway.getOnlineWifiMacs('HWTC1')).resolves.toHaveLength(4);
  });
});
