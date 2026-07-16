/**
 * smartolt-provision (K2) — SmartOltHttpGateway contra un TRANSPORT FAKE
 * (AxiosInstance inyectado). REGLA DURA: jamás se toca ipnext.smartolt.com —
 * todos los shapes de acá vienen del intel verificado de la skill smartolt-ipnext.
 *
 * Cubre:
 *  - X-Token por request + form-encoding de los POSTs.
 *  - Mapeo del shape crudo unconfigured_onus → UnconfiguredOnu de dominio.
 *  - Mapeo de errores: status:false (HTTP 200) → rejected; 4xx → rejected;
 *    red/timeout/5xx → unreachable; envs ausentes → not_configured SIN tocar el transport.
 *  - Pausas entre llamadas (2s default, sleep inyectable).
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
  /** Respuesta por prefijo de URL; default {status: true}. */
  responses = new Map<string, unknown>();
  /** Error por prefijo de URL (se lanza tal cual). */
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

  async post(
    url: string,
    body?: unknown,
    config?: { headers?: Record<string, unknown> },
  ): Promise<{ data: unknown }> {
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
  sleeps?: number[];
  stepPauseMs?: number;
}) {
  const transport = opts?.transport ?? new FakeTransport();
  const sleeps = opts?.sleeps ?? [];
  const gateway = new SmartOltHttpGateway({
    baseUrl: opts?.baseUrl ?? 'https://ipnext.example/api',
    token: opts?.token ?? 'tok-123',
    stepPauseMs: opts?.stepPauseMs ?? 2000,
    http: transport.asAxios(),
    sleep: async ms => {
      sleeps.push(ms);
    },
  });
  return { gateway, transport, sleeps };
}

const RAW_ONU = {
  sn: 'HWTC11112222',
  onu_type_name: 'HG8546M',
  onu_type_id: 15,
  olt_id: 1,
  board: 0,
  port: 3,
  pon_type: 'gpon',
  actions: ['authorize'],
};

describe('SmartOltHttpGateway — envs ausentes (opt-in apagado)', () => {
  it('sin baseUrl/token → OltProvisioningError not_configured SIN tocar el transport', async () => {
    const { gateway, transport } = buildGateway({ baseUrl: '', token: '' });

    await expect(gateway.listUnconfiguredOnus()).rejects.toMatchObject({
      name: 'OltProvisioningError',
      reason: 'not_configured',
      code: 'SMARTOLT_NOT_CONFIGURED',
    });
    await expect(gateway.enableTr069('HWTC11112222', 'SmartOLT')).rejects.toMatchObject({
      reason: 'not_configured',
    });
    expect(transport.calls).toHaveLength(0);
  });
});

describe('SmartOltHttpGateway — listUnconfiguredOnus', () => {
  it('GET onu/unconfigured_onus con X-Token; mapea el shape crudo a dominio', async () => {
    const { gateway, transport } = buildGateway();
    transport.responses.set('onu/unconfigured_onus', {
      status: true,
      response: [RAW_ONU, { ...RAW_ONU, sn: 'ZTEGC1234567', actions: [] }],
    });

    const onus = await gateway.listUnconfiguredOnus();

    expect(transport.calls[0]).toMatchObject({
      method: 'get',
      url: 'onu/unconfigured_onus',
      headers: { 'X-Token': 'tok-123' },
    });
    expect(onus).toEqual([
      {
        sn: 'HWTC11112222',
        onuTypeName: 'HG8546M',
        onuTypeId: '15',
        oltId: '1',
        board: '0',
        port: '3',
        ponType: 'gpon',
        supportsAuthorize: true,
      },
      expect.objectContaining({ sn: 'ZTEGC1234567', supportsAuthorize: false }),
    ]);
  });

  it('response ausente/no-array → lista vacía (defensivo)', async () => {
    const { gateway, transport } = buildGateway();
    transport.responses.set('onu/unconfigured_onus', { status: true });
    expect(await gateway.listUnconfiguredOnus()).toEqual([]);
  });
});

describe('SmartOltHttpGateway — POSTs form-encoded', () => {
  it('authorizeOnu postea los params (PARAMS SIN VERIFICAR) como form', async () => {
    const { gateway, transport } = buildGateway();

    await gateway.authorizeOnu({
      sn: 'HWTC11112222',
      oltId: '1',
      ponType: 'gpon',
      board: '0',
      port: '3',
      onuTypeName: 'HG8546M',
      vlan: 246,
      name: 'HERNANDEZ RONALD [45123]',
      downloadSpeedProfileName: '300M',
      uploadSpeedProfileName: '300M',
    });

    const call = transport.calls[0]!;
    expect(call).toMatchObject({ method: 'post', url: 'onu/authorize_onu' });
    expect(call.headers).toMatchObject({ 'X-Token': 'tok-123' });
    const form = call.body as URLSearchParams;
    expect(form).toBeInstanceOf(URLSearchParams);
    expect(form.get('olt_id')).toBe('1');
    expect(form.get('pon_type')).toBe('gpon');
    expect(form.get('board')).toBe('0');
    expect(form.get('port')).toBe('3');
    expect(form.get('sn')).toBe('HWTC11112222');
    expect(form.get('onu_type')).toBe('HG8546M');
    expect(form.get('vlan')).toBe('246');
    expect(form.get('name')).toBe('HERNANDEZ RONALD [45123]');
    expect(form.get('onu_mode')).toBe('Routing');
    expect(form.get('download_speed_profile_name')).toBe('300M');
    expect(form.get('upload_speed_profile_name')).toBe('300M');
  });

  it('authorizeOnu SIN speed profiles → los params de profile NO viajan', async () => {
    const { gateway, transport } = buildGateway();

    await gateway.authorizeOnu({
      sn: 'HWTC11112222',
      oltId: '3',
      ponType: 'gpon',
      board: '0',
      port: '1',
      onuTypeName: 'HG8546M',
      vlan: 1500,
      name: 'X',
      downloadSpeedProfileName: null,
      uploadSpeedProfileName: null,
    });

    const form = transport.calls[0]!.body as URLSearchParams;
    expect(form.has('download_speed_profile_name')).toBe(false);
    expect(form.has('upload_speed_profile_name')).toBe(false);
  });

  it('setMgmtIp → POST onu/set_onu_mgmt_ip_static_ip/<sn> con vlan', async () => {
    const { gateway, transport } = buildGateway();
    await gateway.setMgmtIp('HWTC11112222', 11);
    const call = transport.calls[0]!;
    expect(call.url).toBe('onu/set_onu_mgmt_ip_static_ip/HWTC11112222');
    expect((call.body as URLSearchParams).get('vlan')).toBe('11');
  });

  it('enableTr069 → POST onu/enable_tr069/<sn> con tr069_profile', async () => {
    const { gateway, transport } = buildGateway();
    await gateway.enableTr069('HWTC11112222', 'SmartOLT');
    const call = transport.calls[0]!;
    expect(call.url).toBe('onu/enable_tr069/HWTC11112222');
    expect((call.body as URLSearchParams).get('tr069_profile')).toBe('SmartOLT');
  });

  it('allowRemoteWanAccess → POST onu/enable_allow_remote_access_to_wan_ip/<sn>', async () => {
    const { gateway, transport } = buildGateway();
    await gateway.allowRemoteWanAccess('HWTC11112222');
    expect(transport.calls[0]!.url).toBe('onu/enable_allow_remote_access_to_wan_ip/HWTC11112222');
  });

  it('setWifi → POST onu/set_wifi_port_lan/<sn> con wifi_port/ssid/password/WPA2/dhcp "No control"', async () => {
    const { gateway, transport } = buildGateway();

    await gateway.setWifi('HWTC11112222', {
      port: 'wifi_0/1',
      ssid: 'IPNEXT_HERNANDEZ_2.4',
      password: '45123777',
    });

    const call = transport.calls[0]!;
    expect(call.url).toBe('onu/set_wifi_port_lan/HWTC11112222');
    const form = call.body as URLSearchParams;
    expect(form.get('wifi_port')).toBe('wifi_0/1');
    expect(form.get('ssid')).toBe('IPNEXT_HERNANDEZ_2.4');
    expect(form.get('password')).toBe('45123777');
    expect(form.get('authentication_mode')).toBe('WPA2');
    expect(form.get('dhcp')).toBe('No control');
  });
});

describe('SmartOltHttpGateway — mapeo de errores', () => {
  it('HTTP 200 con status:false → rejected con el error de SmartOLT como detail', async () => {
    const { gateway, transport } = buildGateway();
    transport.responses.set('onu/set_wifi_port_lan/', {
      status: false,
      error: 'Invalid parameters',
    });

    await expect(
      gateway.setWifi('HWTC11112222', { port: 'wifi_0/5', ssid: 'X', password: '12345678' }),
    ).rejects.toMatchObject({
      name: 'OltProvisioningError',
      reason: 'rejected',
      code: 'SMARTOLT_REJECTED',
      detail: 'Invalid parameters',
    });
  });

  it('HTTP 4xx (axios error con response) → rejected', async () => {
    const { gateway, transport } = buildGateway();
    transport.errors.set('onu/enable_tr069/', {
      isAxiosError: true,
      message: 'Request failed with status code 403',
      response: { status: 403, data: { status: false, error: 'API token invalid' } },
    });

    await expect(gateway.enableTr069('HWTC11112222', 'SmartOLT')).rejects.toMatchObject({
      reason: 'rejected',
    });
  });

  it('red caída / timeout → unreachable', async () => {
    const { gateway, transport } = buildGateway();
    transport.errors.set('onu/unconfigured_onus', new Error('connect ECONNREFUSED'));

    await expect(gateway.listUnconfiguredOnus()).rejects.toMatchObject({
      reason: 'unreachable',
      code: 'SMARTOLT_UNREACHABLE',
    });
  });

  it('HTTP 5xx → unreachable (SmartOLT no respondió bien)', async () => {
    const { gateway, transport } = buildGateway();
    transport.errors.set('onu/authorize_onu', {
      isAxiosError: true,
      message: 'Request failed with status code 502',
      response: { status: 502, data: 'Bad gateway' },
    });

    await expect(
      gateway.authorizeOnu({
        sn: 'HWTC11112222',
        oltId: '1',
        ponType: 'gpon',
        board: '0',
        port: '3',
        onuTypeName: 'HG8546M',
        vlan: 246,
        name: 'X',
        downloadSpeedProfileName: null,
        uploadSpeedProfileName: null,
      }),
    ).rejects.toMatchObject({ reason: 'unreachable' });
  });
});

describe('SmartOltHttpGateway — pausas entre pasos (rate limit 10/s)', () => {
  it('primera llamada SIN pausa; las siguientes esperan stepPauseMs', async () => {
    const { gateway, sleeps } = buildGateway({ stepPauseMs: 2000 });

    await gateway.enableTr069('HWTC11112222', 'SmartOLT');
    expect(sleeps).toEqual([]);

    await gateway.allowRemoteWanAccess('HWTC11112222');
    await gateway.setWifi('HWTC11112222', { port: 'wifi_0/1', ssid: 'X', password: '12345678' });

    expect(sleeps).toEqual([2000, 2000]);
  });

  it('la pausa es calibrable (stepPauseMs inyectado)', async () => {
    const { gateway, sleeps } = buildGateway({ stepPauseMs: 500 });
    await gateway.setMgmtIp('HWTC11112222', 11);
    await gateway.setMgmtIp('HWTC11112222', 11);
    expect(sleeps).toEqual([500]);
  });
});
