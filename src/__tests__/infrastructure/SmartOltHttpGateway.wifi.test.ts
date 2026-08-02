/**
 * wifi-self-service (F0) — extensión de `SmartOltHttpGateway` para implementar
 * `WifiManagementPort` (getOnuWifiStatus/setWifiBand/getRouterHosts). Mismo
 * transport fake que `SmartOltHttpGateway.test.ts` — REGLA DURA: jamás se toca
 * ipnext.smartolt.com.
 *
 * ⚠ SHAPE NO RE-VERIFICADO EN VIVO en esta sesión (F0 es un cambio de código,
 * sin acceso a la API real). Sigue LITERALMENTE la especificación de CAMPOS
 * de dominio del proposal (found/onuType/online/tr069Enabled/bands con
 * port/ssid/enabled; hosts con InterfaceType==='802.11' -> wifi, tal cual
 * dicta el proposal). El mapeo crudo->dominio vive en funciones AISLADAS
 * (toOnuWifiStatus/toRouterHost) para poder ajustar nombres de campo tras un
 * dry-run real con un cambio de una función — mismo patrón que "PARAMS SIN
 * VERIFICAR" ya usado acá para authorizeOnu.
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

function buildGateway(opts?: {
  baseUrl?: string;
  token?: string;
  transport?: FakeTransport;
  clock?: number[];
}) {
  const transport = opts?.transport ?? new FakeTransport();
  let currentTime = opts?.clock?.[0] ?? 0;
  const gateway = new SmartOltHttpGateway({
    baseUrl: opts?.baseUrl ?? 'https://ipnext.example/api',
    token: opts?.token ?? 'tok-123',
    stepPauseMs: 0,
    http: transport.asAxios(),
    sleep: async () => {},
    now: () => currentTime,
  });
  return {
    gateway,
    transport,
    advance: (ms: number) => {
      currentTime += ms;
    },
  };
}

const RAW_DETAILS_8_PORTS = {
  status: true,
  response: {
    sn: 'HWTC189C07AA',
    onu_type: 'HG8145V5',
    state: 'Online',
    tr069: 'Enabled',
    wifi_ports: [
      { port: 'wifi_0/1', ssid: 'Familia_Perez', enable: 'Enabled' },
      { port: 'wifi_0/2', ssid: null, enable: 'Disabled' },
      { port: 'wifi_0/3', ssid: null, enable: 'Disabled' },
      { port: 'wifi_0/4', ssid: null, enable: 'Disabled' },
      { port: 'wifi_0/5', ssid: 'Familia_Perez_5G', enable: 'Enabled' },
      { port: 'wifi_0/6', ssid: null, enable: 'Disabled' },
      { port: 'wifi_0/7', ssid: null, enable: 'Disabled' },
      { port: 'wifi_0/8', ssid: null, enable: 'Disabled' },
    ],
  },
};

describe('SmartOltHttpGateway — getOnuWifiStatus', () => {
  it('GET onu/get_onu_details/<sn> con X-Token; mapea a OnuWifiStatus de dominio', async () => {
    const { gateway, transport } = buildGateway();
    transport.responses.set('onu/get_onu_details/HWTC189C07AA', RAW_DETAILS_8_PORTS);

    const status = await gateway.getOnuWifiStatus('HWTC189C07AA');

    expect(transport.calls[0]).toMatchObject({
      method: 'get',
      url: 'onu/get_onu_details/HWTC189C07AA',
      headers: { 'X-Token': 'tok-123' },
    });
    expect(status).toEqual({
      found: true,
      onuType: 'HG8145V5',
      online: true,
      tr069Enabled: true,
      bands: [
        { band: '2.4', port: 'wifi_0/1', ssid: 'Familia_Perez', enabled: true },
        { band: '5', port: 'wifi_0/5', ssid: 'Familia_Perez_5G', enabled: true },
      ],
    });
  });

  it('tr069 Disabled -> tr069Enabled: false', async () => {
    const { gateway, transport } = buildGateway();
    transport.responses.set('onu/get_onu_details/HWTC1', {
      status: true,
      response: { ...RAW_DETAILS_8_PORTS.response, tr069: 'Disabled' },
    });
    const status = await gateway.getOnuWifiStatus('HWTC1');
    expect(status.tr069Enabled).toBe(false);
  });

  it('0 puertos wifi -> bands: [] (bridge)', async () => {
    const { gateway, transport } = buildGateway();
    transport.responses.set('onu/get_onu_details/HWTC2', {
      status: true,
      response: { ...RAW_DETAILS_8_PORTS.response, wifi_ports: [] },
    });
    const status = await gateway.getOnuWifiStatus('HWTC2');
    expect(status.bands).toEqual([]);
  });

  it('serial no encontrado (SmartOLT rechaza) -> found:false, SIN tirar', async () => {
    const { gateway, transport } = buildGateway();
    transport.responses.set('onu/get_onu_details/DESCONOCIDO', {
      status: false,
      error: 'ONU not found',
    });
    const status = await gateway.getOnuWifiStatus('DESCONOCIDO');
    expect(status).toEqual({ found: false, onuType: null, online: false, tr069Enabled: false, bands: [] });
  });

  it('envs ausentes -> OltProvisioningError not_configured (SÍ propaga, no lo traga found:false)', async () => {
    const { gateway, transport } = buildGateway({ baseUrl: '', token: '' });
    await expect(gateway.getOnuWifiStatus('HWTC1')).rejects.toMatchObject({
      reason: 'not_configured',
      code: 'SMARTOLT_NOT_CONFIGURED',
    });
    expect(transport.calls).toHaveLength(0);
  });

  it('red caída (unreachable) -> propaga, NO lo convierte en found:false', async () => {
    const { gateway, transport } = buildGateway();
    transport.errors.set('onu/get_onu_details/HWTC1', new Error('ECONNREFUSED'));
    await expect(gateway.getOnuWifiStatus('HWTC1')).rejects.toBeInstanceOf(OltProvisioningError);
    await expect(gateway.getOnuWifiStatus('HWTC1')).rejects.toMatchObject({ reason: 'unreachable' });
  });

  it('cache: 2do call dentro del TTL (60s) NO vuelve a pegarle a la red', async () => {
    const { gateway, transport, advance } = buildGateway();
    transport.responses.set('onu/get_onu_details/HWTC189C07AA', RAW_DETAILS_8_PORTS);

    await gateway.getOnuWifiStatus('HWTC189C07AA');
    advance(59_000);
    await gateway.getOnuWifiStatus('HWTC189C07AA');

    expect(transport.calls).toHaveLength(1);
  });

  it('cache: expira a los 60s -> vuelve a pegarle a la red', async () => {
    const { gateway, transport, advance } = buildGateway();
    transport.responses.set('onu/get_onu_details/HWTC189C07AA', RAW_DETAILS_8_PORTS);

    await gateway.getOnuWifiStatus('HWTC189C07AA');
    advance(60_001);
    await gateway.getOnuWifiStatus('HWTC189C07AA');

    expect(transport.calls).toHaveLength(2);
  });
});

describe('SmartOltHttpGateway — setWifiBand', () => {
  it('POST onu/set_wifi_port_lan/<sn> con wifi_port/ssid/password/WPA2, puerto arbitrario', async () => {
    const { gateway, transport } = buildGateway();

    await gateway.setWifiBand('HWTC189C07AA', { port: 'wifi_0/6', ssid: 'RedNueva', password: '12345678' });

    const call = transport.calls[0]!;
    expect(call.url).toBe('onu/set_wifi_port_lan/HWTC189C07AA');
    const form = call.body as URLSearchParams;
    expect(form.get('wifi_port')).toBe('wifi_0/6');
    expect(form.get('ssid')).toBe('RedNueva');
    expect(form.get('password')).toBe('12345678');
    expect(form.get('authentication_mode')).toBe('WPA2');
  });

  it('invalida la cache de getOnuWifiStatus de ESA sn', async () => {
    const { gateway, transport } = buildGateway();
    transport.responses.set('onu/get_onu_details/HWTC189C07AA', RAW_DETAILS_8_PORTS);

    await gateway.getOnuWifiStatus('HWTC189C07AA'); // 1 call, cachea
    await gateway.setWifiBand('HWTC189C07AA', { port: 'wifi_0/1', ssid: 'X', password: '12345678' });
    await gateway.getOnuWifiStatus('HWTC189C07AA'); // cache invalidada -> pega la red de nuevo

    const getCalls = transport.calls.filter((c) => c.method === 'get');
    expect(getCalls).toHaveLength(2);
  });

  it('NO invalida la cache de OTRA sn', async () => {
    const { gateway, transport } = buildGateway();
    transport.responses.set('onu/get_onu_details/SN_A', RAW_DETAILS_8_PORTS);

    await gateway.getOnuWifiStatus('SN_A');
    await gateway.setWifiBand('SN_B', { port: 'wifi_0/1', ssid: 'X', password: '12345678' });
    await gateway.getOnuWifiStatus('SN_A'); // sigue cacheado

    const getCalls = transport.calls.filter((c) => c.method === 'get');
    expect(getCalls).toHaveLength(1);
  });
});

describe('SmartOltHttpGateway — getRouterHosts', () => {
  it('GET onu/get_onu_router_hosts/<sn>; mapea InterfaceType 802.11 -> wifi, resto -> ethernet', async () => {
    const { gateway, transport } = buildGateway();
    transport.responses.set('onu/get_onu_router_hosts/HWTC189C07AA', {
      status: true,
      response: [
        { HostName: 'iPhone-de-Juan', IPAddress: '192.168.1.5', MACAddress: 'AA:BB:CC:00:11:22', InterfaceType: '802.11', Active: true, Vendor: 'Apple' },
        { HostName: 'PC-Escritorio', IPAddress: '192.168.1.10', MACAddress: 'AA:BB:CC:00:11:33', InterfaceType: 'Ethernet', Active: false, Vendor: null },
      ],
    });

    const hosts = await gateway.getRouterHosts('HWTC189C07AA');

    expect(transport.calls[0]).toMatchObject({ method: 'get', url: 'onu/get_onu_router_hosts/HWTC189C07AA' });
    expect(hosts).toEqual([
      { hostName: 'iPhone-de-Juan', ip: '192.168.1.5', mac: 'AA:BB:CC:00:11:22', interfaceType: 'wifi', active: true, vendor: 'Apple' },
      { hostName: 'PC-Escritorio', ip: '192.168.1.10', mac: 'AA:BB:CC:00:11:33', interfaceType: 'ethernet', active: false, vendor: null },
    ]);
  });

  it('response ausente/no-array -> lista vacía (defensivo)', async () => {
    const { gateway, transport } = buildGateway();
    transport.responses.set('onu/get_onu_router_hosts/HWTC1', { status: true });
    expect(await gateway.getRouterHosts('HWTC1')).toEqual([]);
  });

  it('NO está cacheado — cada call pega la red', async () => {
    const { gateway, transport } = buildGateway();
    transport.responses.set('onu/get_onu_router_hosts/HWTC1', { status: true, response: [] });
    await gateway.getRouterHosts('HWTC1');
    await gateway.getRouterHosts('HWTC1');
    expect(transport.calls).toHaveLength(2);
  });
});
