import axios, { AxiosInstance, isAxiosError } from 'axios';
import {
  OltProvisioningGateway,
  UnconfiguredOnu,
  AuthorizeOnuInput,
  SetWifiInput,
} from '@domain/ports/OltProvisioningGateway';
import { OltProvisioningError } from '@domain/errors/smartolt';

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
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_STEP_PAUSE_MS = 2_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Shape crudo de una fila de GET onu/unconfigured_onus (verificado en la skill smartolt-ipnext). */
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
export class SmartOltHttpGateway implements OltProvisioningGateway {
  private readonly http: AxiosInstance;
  private readonly token: string;
  private readonly configured: boolean;
  private readonly stepPauseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastCallAt: number | null = null;

  constructor(opts: SmartOltHttpGatewayOptions) {
    this.token = opts.token;
    this.configured = opts.baseUrl !== '' && opts.token !== '';
    this.stepPauseMs = opts.stepPauseMs ?? DEFAULT_STEP_PAUSE_MS;
    this.sleep = opts.sleep ?? defaultSleep;
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

  /**
   * Guard de configuración + pausa anti-burst + mapeo de errores. TODA llamada
   * a SmartOLT pasa por acá.
   */
  private async call<T>(fn: () => Promise<{ data: T }>): Promise<T> {
    if (!this.configured) {
      throw new OltProvisioningError(
        'not_configured',
        'SmartOLT no está configurado (SMARTOLT_BASE_URL / SMARTOLT_API_TOKEN ausentes) — feature apagada',
      );
    }
    if (this.lastCallAt !== null) await this.sleep(this.stepPauseMs);
    this.lastCallAt = Date.now();

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

    // SmartOLT responde 200 con {status: false, error: "..."} en los rechazos.
    const status = (data as { status?: unknown } | null)?.status;
    if (status === false || status === 'false') {
      const body = data as { error?: unknown; message?: unknown };
      const detail =
        (typeof body.error === 'string' && body.error) ||
        (typeof body.message === 'string' && body.message) ||
        'SmartOLT rechazó la operación (status false)';
      throw new OltProvisioningError('rejected', detail);
    }
    return data;
  }

  private post(url: string, form: URLSearchParams): Promise<unknown> {
    return this.call(() => this.http.post(url, form, { headers: this.headers() }));
  }

  // ── OltProvisioningGateway ─────────────────────────────────────────────────

  async listUnconfiguredOnus(): Promise<UnconfiguredOnu[]> {
    const data = await this.call<unknown>(() =>
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
    const form = new URLSearchParams();
    form.set('wifi_port', input.port);
    form.set('ssid', input.ssid);
    form.set('password', input.password);
    // Verificado en vivo (skill smartolt-ipnext): WPA2 + dhcp "No control".
    form.set('authentication_mode', 'WPA2');
    form.set('dhcp', 'No control');
    await this.post(`onu/set_wifi_port_lan/${encodeURIComponent(sn)}`, form);
  }
}
