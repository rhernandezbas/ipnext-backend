import axios, { AxiosInstance, isAxiosError } from 'axios';
import {
  OltProvisioningGateway,
  UnconfiguredOnu,
  AuthorizeOnuInput,
  SetWifiInput,
} from '@domain/ports/OltProvisioningGateway';
import { WifiManagementPort, OnuWifiStatus, SetWifiBandInput, RouterHost } from '@domain/ports/WifiManagementPort';
import { OltProvisioningError } from '@domain/errors/smartolt';
import { mapWifiPortsToBands, mapWifiPortsToGuest, RawWifiPort } from '@domain/services/mapWifiPortsToBands';

export interface SmartOltHttpGatewayOptions {
  /** Base de la API, ej. https://ipnext.smartolt.com/api. Vacío = feature apagada. */
  baseUrl: string;
  /** X-Token de la API. Vacío = feature apagada. */
  token: string;
  timeoutMs?: number;
  /**
   * Pausa entre llamadas consecutivas (default 2000ms). SmartOLT ratelimitea
   * (1000/h, 10/s) y el flujo de aprovisionamiento encadena ~6 escrituras:
   * espaciarlas evita el burst. Calibrable por env (SMARTOLT_STEP_PAUSE_MS).
   */
  stepPauseMs?: number;
  /** Inyectable para tests (AxiosInstance fake). En prod se crea internamente. */
  http?: AxiosInstance;
  /** Reloj inyectable para tests — default setTimeout real. */
  sleep?: (ms: number) => Promise<void>;
  /** wifi-self-service (F0) — reloj inyectable para tests de TTL de cache. Default Date.now. */
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_STEP_PAUSE_MS = 2_000;
/** wifi-self-service (F0) — TTL de la cache de `getOnuWifiStatus` (proposal F0: "cache corto"). */
const WIFI_STATUS_CACHE_TTL_MS = 60_000;
/**
 * wifi-portal-read-perf — TTL de la cache de `getRouterHosts`. Elegido en
 * 60s (igual que la de wifi status, por consistencia): la lista de hosts
 * cambia lento (asociaciones DHCP/wifi de la LAN del cliente) y el propio
 * panel de SmartOLT advierte que este dato se refresca cada ~15 min — 60s
 * ya es conservador frente a eso, y alcanza para que navegaciones
 * consecutivas del usuario en la app ("Dispositivos conectados") no
 * vuelvan a pegarle a la red.
 */
const ROUTER_HOSTS_CACHE_TTL_MS = 60_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * wifi-self-service (F0) — shape crudo de GET onu/get_onu_details/<sn>.
 *
 * ✅ VERIFICADO CONTRA EL PAYLOAD REAL del experimento 2026-08-02 (ONU
 * HWTC189C07AA): el wrapper es `onu_details` (NO `response` como los otros
 * endpoints de este gateway), cada puerto trae `admin_state:
 * 'Enabled'|'Disabled'` (NO `enable`), y `status: 'Online'`. El primer draft
 * de esta función usaba `response`/`enable` — con eso la elegibilidad daba
 * `found:false` SIEMPRE en prod, con todos los tests verdes (fixtures
 * inventados). Los fixtures del test ahora son el payload real.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toOnuWifiStatus(raw: any): OnuWifiStatus {
  const r = raw?.onu_details as Record<string, unknown> | null | undefined;
  if (r == null || typeof r !== 'object') {
    return { found: false, onuType: null, online: false, tr069Enabled: false, bands: [], guest: mapWifiPortsToGuest([]) };
  }

  const tr069Raw = r['tr069'];
  const tr069Enabled = typeof tr069Raw === 'string' && tr069Raw.toLowerCase() === 'enabled';

  const stateRaw = r['state'] ?? r['onu_state'] ?? r['status'];
  const online = typeof stateRaw === 'string' && stateRaw.toLowerCase() === 'online';

  const onuTypeRaw = r['onu_type'] ?? r['onu_type_name'];
  const onuType = onuTypeRaw != null ? String(onuTypeRaw) : null;

  const rawPorts = r['wifi_ports'] ?? r['ports'] ?? [];
  const ports: RawWifiPort[] = (Array.isArray(rawPorts) ? rawPorts : [])
    .filter((p: unknown): p is Record<string, unknown> => typeof p === 'object' && p !== null)
    .map((p) => ({
      port: String(p['port'] ?? ''),
      ssid: p['ssid'] != null && p['ssid'] !== '' ? String(p['ssid']) : null,
      // Payload real: `admin_state: 'Enabled'|'Disabled'` — no existe `enable`.
      enabled:
        typeof p['admin_state'] === 'string'
          ? p['admin_state'].toLowerCase() === 'enabled'
          : false,
    }))
    .filter((p) => p.port !== '');

  return {
    found: true,
    onuType,
    online,
    tr069Enabled,
    bands: mapWifiPortsToBands(ports),
    // EPIC v3 (wifi de visitas) — guest derivado de los MISMOS puertos crudos
    // (disponibilidad DINÁMICA: el template puede no traer 5GHz, evidencia
    // HWTCA92F96B1 2026-08-03). ADITIVO — `bands` no cambió de shape.
    guest: mapWifiPortsToGuest(ports),
  };
}

/**
 * wifi-self-service (F0) — shape crudo de una fila de
 * GET onu/get_onu_router_hosts/<sn>.
 *
 * ✅ VERIFICADO CONTRA EL PAYLOAD REAL (experimento 2026-08-02): las claves
 * son `HostName`/`IPAddress`/`MACAddress`/`InterfaceType`/`Active` y el
 * vendor viene como **`VendorClassID`** (ej. "android-dhcp-14") — no existe
 * ninguna clave `Vendor`. `InterfaceType === '802.11' -> wifi`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRouterHost(raw: any): RouterHost {
  const interfaceRaw = raw?.InterfaceType ?? raw?.interface_type;
  const interfaceType: RouterHost['interfaceType'] = interfaceRaw === '802.11' ? 'wifi' : 'ethernet';
  const activeRaw = raw?.Active ?? raw?.active;
  const active = activeRaw === true || activeRaw === 'true' || activeRaw === 1 || activeRaw === '1';
  const hostNameRaw = raw?.HostName ?? raw?.hostname;
  const ipRaw = raw?.IPAddress ?? raw?.ip;
  const macRaw = raw?.MACAddress ?? raw?.mac;
  const vendorRaw = raw?.VendorClassID ?? raw?.vendor;
  // EPIC v3 (red por dispositivo) — el payload real trae `Layer2Interface:
  // 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.<n>'` (fixture del
  // experimento 2026-08-02, antes DESCARTADO): <n> = índice SSID = número de
  // puerto wifi. Ethernet apunta a LANEthernetInterfaceConfig (u omite la
  // clave) -> null.
  const layer2Raw = raw?.Layer2Interface ?? raw?.layer2_interface;
  const wlanMatch = typeof layer2Raw === 'string' ? /WLANConfiguration\.(\d+)$/.exec(layer2Raw) : null;
  return {
    hostName: hostNameRaw != null && hostNameRaw !== '' ? String(hostNameRaw) : null,
    ip: ipRaw != null && ipRaw !== '' ? String(ipRaw) : null,
    mac: macRaw != null && macRaw !== '' ? String(macRaw) : null,
    interfaceType,
    active,
    vendor: vendorRaw != null && vendorRaw !== '' ? String(vendorRaw) : null,
    wlanIndex: wlanMatch ? Number(wlanMatch[1]) : null,
  };
}

/**
 * Shape crudo de una fila de GET onu/unconfigured_onus — verificado contra la
 * instancia real 2026-07-17 (read-only, durante el review adversarial): key raíz
 * `response`, campos sn/onu_type_name/onu_type_id/olt_id/board/port/pon_type/actions.
 * (La skill smartolt-ipnext NO documenta este endpoint — fix M3: el crédito de la
 * verificación estaba mal atribuido.)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toUnconfiguredOnu(r: any): UnconfiguredOnu {
  const actions: unknown = r?.actions;
  return {
    sn: String(r?.sn ?? ''),
    onuTypeName: r?.onu_type_name != null ? String(r.onu_type_name) : null,
    onuTypeId: r?.onu_type_id != null ? String(r.onu_type_id) : null,
    oltId: String(r?.olt_id ?? ''),
    board: r?.board != null ? String(r.board) : null,
    port: r?.port != null ? String(r.port) : null,
    ponType: r?.pon_type != null ? String(r.pon_type) : null,
    supportsAuthorize: Array.isArray(actions) && actions.includes('authorize'),
  };
}

/**
 * smartolt-provision (K2) — cliente HTTP real de la API de SmartOLT.
 *
 * REGLA DURA de desarrollo: este adapter se ejercita SOLO con un transport fake
 * (opción `http`) — jamás contra ipnext.smartolt.com. Cualquier verificación en
 * vivo la decide el usuario (dry-run primero).
 *
 * Contratos:
 *  - Auth por header `X-Token` en CADA request (server-side, nunca al browser).
 *  - POSTs form-encoded (URLSearchParams) — la API es form, no JSON.
 *  - Opt-in: sin baseUrl/token los métodos fallan con reason 'not_configured'
 *    ANTES de tocar la red (patrón ORCHESTRATOR_*: no fail-fast al boot).
 *  - Mapeo de errores:
 *      HTTP 200 con `status: false` → 'rejected' (SmartOLT rechazó; detail = error de la API)
 *      HTTP 4xx                     → 'rejected'
 *      red / timeout / 5xx          → 'unreachable'
 *  - Pausa `stepPauseMs` entre llamadas consecutivas (primera sin pausa) —
 *    respeta el rate limit 10/s de la instancia.
 */
export class SmartOltHttpGateway implements OltProvisioningGateway, WifiManagementPort {
  private readonly http: AxiosInstance;
  private readonly token: string;
  private readonly configured: boolean;
  private readonly stepPauseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private lastCallAt: number | null = null;
  /** wifi-self-service (F0) — cache in-memory de `getOnuWifiStatus`, keyed por sn normalizada. */
  private readonly wifiStatusCache = new Map<string, { value: OnuWifiStatus; expiresAt: number }>();
  /** wifi-portal-read-perf — cache in-memory de `getRouterHosts`, keyed por sn normalizada. */
  private readonly routerHostsCache = new Map<string, { value: RouterHost[]; expiresAt: number }>();

  constructor(opts: SmartOltHttpGatewayOptions) {
    this.token = opts.token;
    this.configured = opts.baseUrl !== '' && opts.token !== '';
    this.stepPauseMs = opts.stepPauseMs ?? DEFAULT_STEP_PAUSE_MS;
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? (() => Date.now());
    this.http =
      opts.http ??
      axios.create({
        baseURL: opts.baseUrl,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
  }

  // ── plumbing ───────────────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    return { 'X-Token': this.token };
  }

  /** Guard de configuración — feature apagada si faltan baseUrl/token. Compartido por lecturas y escrituras. */
  private assertConfigured(): void {
    if (!this.configured) {
      throw new OltProvisioningError(
        'not_configured',
        'SmartOLT no está configurado (SMARTOLT_BASE_URL / SMARTOLT_API_TOKEN ausentes) — feature apagada',
      );
    }
  }

  /** Fetch + mapeo de errores/response, SIN pausa. Compartido por `call()` y `callRead()`. */
  private async execute<T>(fn: () => Promise<{ data: T }>): Promise<T> {
    let data: T;
    try {
      const res = await fn();
      data = res.data;
    } catch (err) {
      if (isAxiosError(err) && err.response !== undefined && err.response.status >= 400 && err.response.status < 500) {
        const body = err.response.data as { error?: unknown; message?: unknown } | null;
        const detail =
          (typeof body?.error === 'string' && body.error) ||
          (typeof body?.message === 'string' && body.message) ||
          `SmartOLT rechazó la petición con ${err.response.status}`;
        throw new OltProvisioningError('rejected', detail);
      }
      throw new OltProvisioningError(
        'unreachable',
        err instanceof Error ? err.message : String(err),
      );
    }

    // SmartOLT responde 200 con {status: false, error: "..."} en los rechazos —
    // y (fix M2) la doc también promete `response_code`: un code de error con
    // status true dejaría el paso "ok fantasma". Se chequean AMBOS.
    const body = data as {
      status?: unknown;
      response_code?: unknown;
      error?: unknown;
      message?: unknown;
    } | null;
    const detail = (fallback: string): string =>
      (typeof body?.error === 'string' && body.error) ||
      (typeof body?.message === 'string' && body.message) ||
      fallback;
    if (body?.status === false || body?.status === 'false') {
      throw new OltProvisioningError('rejected', detail('SmartOLT rechazó la operación (status false)'));
    }
    const rawCode = body?.response_code;
    const code =
      typeof rawCode === 'number' ? rawCode : typeof rawCode === 'string' ? Number.parseInt(rawCode, 10) : NaN;
    if (Number.isInteger(code) && code >= 400) {
      throw new OltProvisioningError('rejected', detail(`SmartOLT rechazó la operación (response_code ${code})`));
    }
    return data;
  }

  /**
   * Guard de configuración + pausa anti-burst + mapeo de errores. Para
   * ESCRITURAS y flujos encadenados de provisioning (authorize → mgmt-ip →
   * tr069 → wifi, etc): el rate limit de SmartOLT es 10/s y esos flujos
   * encadenan varias escrituras seguidas — la pausa espacia esa ráfaga.
   */
  private async call<T>(fn: () => Promise<{ data: T }>): Promise<T> {
    this.assertConfigured();
    if (this.lastCallAt !== null) await this.sleep(this.stepPauseMs);
    this.lastCallAt = Date.now();
    return this.execute(fn);
  }

  /**
   * wifi-portal-read-perf — guard de configuración + mapeo de errores IGUAL
   * que `call()`, pero SIN la pausa anti-burst y SIN tocar `lastCallAt`. Para
   * LECTURAS sueltas (GET) que un cliente dispara directo — el rate limit de
   * SmartOLT es 10/s: un GET aislado no lo viola, la pausa existe para
   * proteger RÁFAGAS de escrituras encadenadas, no lecturas.
   *
   * Antes de este fix, `lastCallAt` era de la instancia COMPARTIDA (un solo
   * gateway wireado en toda la app): un GET pagaba 2s de pausa por una
   * escritura de OTRO flujo que había ocurrido segundos antes, sin ningún
   * burst que proteger. Medido en prod: `GET /api/portal/wifi/:contractId/
   * devices` tardaba 8-12s consistentemente — al borde del timeout de 15s
   * del cliente de la app.
   */
  private async callRead<T>(fn: () => Promise<{ data: T }>): Promise<T> {
    this.assertConfigured();
    return this.execute(fn);
  }

  private post(url: string, form: URLSearchParams): Promise<unknown> {
    return this.call(() => this.http.post(url, form, { headers: this.headers() }));
  }

  // ── OltProvisioningGateway ─────────────────────────────────────────────────

  async listUnconfiguredOnus(): Promise<UnconfiguredOnu[]> {
    const data = await this.callRead<unknown>(() =>
      this.http.get('onu/unconfigured_onus', { headers: this.headers() }),
    );
    const rows: unknown = (data as { response?: unknown } | null)?.response;
    return (Array.isArray(rows) ? rows : []).map(toUnconfiguredOnu);
  }

  /**
   * ⚠ PARAMS SIN VERIFICAR contra la instancia real — validar en el dry-run en
   * vivo. `POST onu/authorize_onu` no está en el intel verificado de la skill;
   * este shape sigue la documentación pública de SmartOLT (colección Postman
   * oficial) según mejor conocimiento: olt_id, pon_type, board, port, sn,
   * onu_type (por NOMBRE), vlan, name, onu_mode y los speed profiles por nombre
   * (omitidos si no derivan del plan). Si la instancia exige params extra
   * (zone/odb), el rechazo llega tipado ('rejected') con el error de la API.
   */
  async authorizeOnu(input: AuthorizeOnuInput): Promise<void> {
    const form = new URLSearchParams();
    form.set('olt_id', input.oltId);
    if (input.ponType !== null) form.set('pon_type', input.ponType);
    if (input.board !== null) form.set('board', input.board);
    if (input.port !== null) form.set('port', input.port);
    form.set('sn', input.sn);
    if (input.onuTypeName !== null) form.set('onu_type', input.onuTypeName);
    form.set('vlan', String(input.vlan));
    form.set('name', input.name);
    form.set('onu_mode', 'Routing');
    if (input.downloadSpeedProfileName !== null) {
      form.set('download_speed_profile_name', input.downloadSpeedProfileName);
    }
    if (input.uploadSpeedProfileName !== null) {
      form.set('upload_speed_profile_name', input.uploadSpeedProfileName);
    }
    await this.post('onu/authorize_onu', form);
  }

  async setMgmtIp(sn: string, vlan: number): Promise<void> {
    const form = new URLSearchParams();
    form.set('vlan', String(vlan));
    await this.post(`onu/set_onu_mgmt_ip_static_ip/${encodeURIComponent(sn)}`, form);
  }

  async enableTr069(sn: string, profile: string): Promise<void> {
    const form = new URLSearchParams();
    form.set('tr069_profile', profile);
    await this.post(`onu/enable_tr069/${encodeURIComponent(sn)}`, form);
  }

  async allowRemoteWanAccess(sn: string): Promise<void> {
    await this.post(
      `onu/enable_allow_remote_access_to_wan_ip/${encodeURIComponent(sn)}`,
      new URLSearchParams(),
    );
  }

  async setWifi(sn: string, input: SetWifiInput): Promise<void> {
    await this.postSetWifiPort(sn, input.port, input.ssid, input.password);
  }

  /**
   * portal-equipment-reboot — POST onu/reboot/<sn> (skill smartolt-ipnext).
   * Sin params extra, mismo patrón que `allowRemoteWanAccess`. wifi-portal-
   * read-perf: invalida la cache de `getRouterHosts` de ESA sn — tras
   * reiniciar el equipo, la lista de hosts conectados cambia y no puede
   * quedar sirviendo el snapshot pre-reboot hasta que expire el TTL.
   */
  async reboot(sn: string): Promise<void> {
    await this.post(`onu/reboot/${encodeURIComponent(sn)}`, new URLSearchParams());
    this.routerHostsCache.delete(sn);
  }

  /** POST onu/set_wifi_port_lan/<sn> — SIEMPRE WPA2, compartido por `setWifi` y `setWifiBand`. */
  private async postSetWifiPort(sn: string, port: string, ssid: string, password: string): Promise<void> {
    const form = new URLSearchParams();
    form.set('wifi_port', port);
    form.set('ssid', ssid);
    form.set('password', password);
    // Verificado en vivo (skill smartolt-ipnext): WPA2 + dhcp "No control".
    form.set('authentication_mode', 'WPA2');
    form.set('dhcp', 'No control');
    await this.post(`onu/set_wifi_port_lan/${encodeURIComponent(sn)}`, form);
  }

  // ── WifiManagementPort ──────────────────────────────────────────────────────

  /**
   * GET onu/get_onu_details/<sn>, cacheado (TTL 60s — el resolver de
   * elegibilidad lo llama seguido). Un "rejected" de SmartOLT (serial
   * desconocido, el caso más común de una GET) se traduce a `found: false` en
   * vez de tirar — es un resultado válido, no una falla de infra.
   * `not_configured`/`unreachable` SÍ propagan (y no se cachean).
   */
  async getOnuWifiStatus(sn: string): Promise<OnuWifiStatus> {
    const cached = this.wifiStatusCache.get(sn);
    if (cached && cached.expiresAt > this.now()) {
      return cached.value;
    }

    let status: OnuWifiStatus;
    try {
      const data = await this.callRead<unknown>(() =>
        this.http.get(`onu/get_onu_details/${encodeURIComponent(sn)}`, { headers: this.headers() }),
      );
      status = toOnuWifiStatus(data);
    } catch (err) {
      if (err instanceof OltProvisioningError && err.reason === 'rejected') {
        status = { found: false, onuType: null, online: false, tr069Enabled: false, bands: [], guest: mapWifiPortsToGuest([]) };
      } else {
        throw err;
      }
    }

    this.wifiStatusCache.set(sn, { value: status, expiresAt: this.now() + WIFI_STATUS_CACHE_TTL_MS });
    return status;
  }

  /**
   * POST onu/set_wifi_port_lan/<sn> con un puerto EXPLÍCITO (a diferencia de
   * `setWifi`, que solo acepta 'wifi_0/1' | 'wifi_0/5' — acá el caller decide,
   * mismo endpoint). Invalida la cache de `getOnuWifiStatus` de ESA sn: el
   * próximo GET tiene que reflejar el SSID nuevo, no el stale.
   */
  async setWifiBand(sn: string, input: SetWifiBandInput): Promise<void> {
    await this.postSetWifiPort(sn, input.port, input.ssid, input.password);
    this.wifiStatusCache.delete(sn);
  }

  /**
   * EPIC v3 (wifi de visitas) — POST onu/shutdown_wifi_port/<sn> con form
   * `wifi_port` (ÚNICO param — verificado contra la colección Postman oficial
   * de SmartOLT, 2026-08-03). Invalida la cache de `getOnuWifiStatus` de ESA
   * sn: el próximo GET debe ver el puerto `enabled:false`, no el snapshot
   * stale (misma disciplina que `setWifiBand`). Fix wave S3: invalida TAMBIÉN
   * la cache de `getRouterHosts` — apagar la red desasocia a sus devices y la
   * lista cacheada los seguía mostrando hasta 60s (misma disciplina que
   * `reboot`).
   */
  async shutdownWifiPort(sn: string, port: string): Promise<void> {
    const form = new URLSearchParams();
    form.set('wifi_port', port);
    await this.post(`onu/shutdown_wifi_port/${encodeURIComponent(sn)}`, form);
    this.wifiStatusCache.delete(sn);
    this.routerHostsCache.delete(sn);
  }

  /**
   * GET onu/get_onu_router_hosts/<sn>, cacheado (TTL 60s — wifi-portal-read-
   * perf: cada visita a "Dispositivos conectados" de la app lo pegaba en
   * vivo, sumado a la pausa anti-burst compartida daba 8-12s por request,
   * al borde del timeout de 15s del cliente). Invalidado por `reboot(sn)`.
   *
   * Payload REAL (experimento 2026-08-02): `{ response: { hostlist: { "1":
   * {...}, "2": {...} } } }` — un OBJETO indexado por string, NO un array. El
   * primer draft esperaba `response` como array y devolvía `[]` siempre.
   */
  async getRouterHosts(sn: string): Promise<RouterHost[]> {
    const cached = this.routerHostsCache.get(sn);
    if (cached && cached.expiresAt > this.now()) {
      return cached.value;
    }

    const data = await this.callRead<unknown>(() =>
      this.http.get(`onu/get_onu_router_hosts/${encodeURIComponent(sn)}`, { headers: this.headers() }),
    );
    const response = (data as { response?: unknown } | null)?.response;
    const hostlist = (response as { hostlist?: unknown } | null)?.hostlist;
    const rows = hostlist != null && typeof hostlist === 'object' ? Object.values(hostlist) : [];
    const hosts = rows
      .filter((r: unknown): r is Record<string, unknown> => typeof r === 'object' && r !== null)
      .map(toRouterHost);

    this.routerHostsCache.set(sn, { value: hosts, expiresAt: this.now() + ROUTER_HOSTS_CACHE_TTL_MS });
    return hosts;
  }
}
