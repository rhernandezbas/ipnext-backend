/**
 * wifi-self-service (F0) — extensión de `SmartOltHttpGateway` para implementar
 * `WifiManagementPort` (getOnuWifiStatus/setWifiBand/getRouterHosts). Mismo
 * transport fake que `SmartOltHttpGateway.test.ts` — REGLA DURA: jamás se toca
 * ipnext.smartolt.com.
 *
 * SHAPES VERIFICADOS CONTRA LOS PAYLOADS REALES del experimento
 * 2026-08-02 (ONU HWTC189C07AA): wrapper `onu_details` (no `response`),
 * puertos con `admin_state` (no `enable`), hosts como `response.hostlist`
 * (objeto indexado por string, no array) y vendor en `VendorClassID`.
 *
 * El draft original uso fixtures inventados y certificaba un mapper que en
 * prod devolvia found:false y hosts [] SIEMPRE — la clase exacta de bug
 * "tests verdes, feature inerte". Si SmartOLT cambia el shape, estos
 * fixtures son la referencia de QUE devolvia el 2026-08-02.
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

// PAYLOAD REAL del experimento 2026-08-02 contra la ONU de prueba (recortado a
// los campos que el mapper consume + los hermanos que confunden). Claves
// verificadas EN VIVO: wrapper `onu_details` (no `response`), `status:
// 'Online'`, puertos con `admin_state` (no `enable`) y `auth_mode`/`mode` de
// ruido alrededor. El fixture anterior era inventado y certificaba un mapper
// que en prod devolvía found:false SIEMPRE.
const RAW_DETAILS_8_PORTS = {
  status: true,
  response_code: 'success',
  onu_details: {
    sn: 'HWTC189C07AA',
    onu_type_name: 'HG8145V5',
    status: 'Online',
    tr069: 'Enabled',
    wifi_ports: [
      { port: 'wifi_0/1', admin_state: 'Enabled', mode: 'LAN', dhcp: 'No control', auth_mode: 'wpa2', ssid: 'Familia_Perez', password: null },
      { port: 'wifi_0/2', admin_state: 'Disabled', mode: 'LAN', dhcp: 'No control', auth_mode: 'wpa2', ssid: null, password: null },
      { port: 'wifi_0/3', admin_state: 'Disabled', mode: 'LAN', dhcp: 'No control', auth_mode: 'wpa2', ssid: null, password: null },
      { port: 'wifi_0/4', admin_state: 'Disabled', mode: 'LAN', dhcp: 'No control', auth_mode: 'wpa2', ssid: null, password: null },
      { port: 'wifi_0/5', admin_state: 'Enabled', mode: 'LAN', dhcp: 'No control', auth_mode: 'wpa2', ssid: 'Familia_Perez_5G', password: null },
      { port: 'wifi_0/6', admin_state: 'Disabled', mode: 'LAN', dhcp: 'No control', auth_mode: 'wpa2', ssid: null, password: null },
      { port: 'wifi_0/7', admin_state: 'Disabled', mode: 'LAN', dhcp: 'No control', auth_mode: 'wpa2', ssid: null, password: null },
      { port: 'wifi_0/8', admin_state: 'Disabled', mode: 'LAN', dhcp: 'No control', auth_mode: 'wpa2', ssid: null, password: null },
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
      onu_details: { ...RAW_DETAILS_8_PORTS.onu_details, tr069: 'Disabled' },
    });
    const status = await gateway.getOnuWifiStatus('HWTC1');
    expect(status.tr069Enabled).toBe(false);
  });

  it('0 puertos wifi -> bands: [] (bridge)', async () => {
    const { gateway, transport } = buildGateway();
    transport.responses.set('onu/get_onu_details/HWTC2', {
      status: true,
      onu_details: { ...RAW_DETAILS_8_PORTS.onu_details, wifi_ports: [] },
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
      // PAYLOAD REAL del experimento 2026-08-02: `response.hostlist` es un
      // OBJETO indexado por string (no un array), y el vendor viene como
      // `VendorClassID`. El fixture anterior (array + `Vendor`) era inventado
      // y certificaba un parser que en prod devolvía [] SIEMPRE.
      status: true,
      response_code: 'success',
      response: {
        hostlist: {
          '1': {
            Active: false, AddressSource: 'DHCP', ClientID: '', HostName: 'A13-de-Blanca',
            IPAddress: '10.22.22.9', InterfaceType: '802.11',
            Layer2Interface: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1',
            LeaseTimeRemaining: 2007, MACAddress: '9e:c3:9d:2f:f6:b6',
            UserClassID: '', VendorClassID: 'android-dhcp-14', X_HW_Stats: null,
          },
          '2': {
            Active: true, AddressSource: 'DHCP', ClientID: '', HostName: 'PC-Escritorio',
            IPAddress: '10.22.22.77', InterfaceType: 'Ethernet',
            Layer2Interface: 'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1',
            LeaseTimeRemaining: 57955, MACAddress: '8e:4e:b9:63:64:4a',
            UserClassID: '', VendorClassID: '', X_HW_Stats: null,
          },
        },
      },
    });

    const hosts = await gateway.getRouterHosts('HWTC189C07AA');

    expect(transport.calls[0]).toMatchObject({ method: 'get', url: 'onu/get_onu_router_hosts/HWTC189C07AA' });
    expect(hosts).toEqual([
      { hostName: 'A13-de-Blanca', ip: '10.22.22.9', mac: '9e:c3:9d:2f:f6:b6', interfaceType: 'wifi', active: false, vendor: 'android-dhcp-14' },
      { hostName: 'PC-Escritorio', ip: '10.22.22.77', mac: '8e:4e:b9:63:64:4a', interfaceType: 'ethernet', active: true, vendor: null },
    ]);
  });

  it('response ausente/no-array -> lista vacía (defensivo)', async () => {
    const { gateway, transport } = buildGateway();
    transport.responses.set('onu/get_onu_router_hosts/HWTC1', { status: true });
    expect(await gateway.getRouterHosts('HWTC1')).toEqual([]);
  });

  /**
   * wifi-portal-read-perf — a diferencia del draft original ("NO cacheado —
   * no se llama seguido"), medido en prod: CADA visita a "Dispositivos
   * conectados" en la app pega en vivo, y sumado a la pausa anti-burst
   * (ver SmartOltHttpGateway.test.ts) daba 8-12s por request. TTL 60s: la
   * lista de hosts cambia lento (asociaciones DHCP/wifi), y el propio panel
   * de SmartOLT avisa que refresca este dato cada ~15 min — 60s es
   * conservador en comparación y ya elimina el hit en vivo de navegaciones
   * consecutivas del usuario.
   */
  it('cache: 2do call dentro del TTL (60s) NO vuelve a pegarle a la red', async () => {
    const { gateway, transport, advance } = buildGateway();
    transport.responses.set('onu/get_onu_router_hosts/HWTC1', { status: true, response: { hostlist: {} } });

    await gateway.getRouterHosts('HWTC1');
    advance(59_000);
    await gateway.getRouterHosts('HWTC1');

    expect(transport.calls).toHaveLength(1);
  });

  it('cache: expira a los 60s -> vuelve a pegarle a la red', async () => {
    const { gateway, transport, advance } = buildGateway();
    transport.responses.set('onu/get_onu_router_hosts/HWTC1', { status: true, response: { hostlist: {} } });

    await gateway.getRouterHosts('HWTC1');
    advance(60_001);
    await gateway.getRouterHosts('HWTC1');

    expect(transport.calls).toHaveLength(2);
  });

  it('reboot(sn) invalida SOLO la cache de hosts de ESA sn', async () => {
    const { gateway, transport } = buildGateway();
    transport.responses.set('onu/get_onu_router_hosts/SN_A', { status: true, response: { hostlist: {} } });
    transport.responses.set('onu/get_onu_router_hosts/SN_B', { status: true, response: { hostlist: {} } });

    await gateway.getRouterHosts('SN_A'); // cachea SN_A
    await gateway.getRouterHosts('SN_B'); // cachea SN_B
    await gateway.reboot('SN_A');
    await gateway.getRouterHosts('SN_A'); // cache invalidada -> pega la red
    await gateway.getRouterHosts('SN_B'); // sigue cacheado -> NO pega la red

    const hostCalls = transport.calls.filter(
      (c) => c.method === 'get' && c.url.startsWith('onu/get_onu_router_hosts'),
    );
    expect(hostCalls).toHaveLength(3); // SN_A, SN_B, SN_A de nuevo
  });
});
