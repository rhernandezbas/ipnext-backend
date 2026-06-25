import axios, { AxiosInstance, isAxiosError } from 'axios';
import {
  RadiusOrchestratorGateway,
  OrchestratorSession,
  ChangePlanOptions,
  SuspendOptions,
  CreateRadiusUserInput,
  RadiusUserInventoryItem,
  ListAccountingFilters,
  AccountingPage,
  AccountingEventRow,
  ListPostauthFilters,
  PostauthPage,
  AuthEventRow,
} from '@domain/ports/RadiusOrchestratorGateway';
import { OrchestratorUnreachableError, OrchestratorRejectedError } from '@domain/errors/pppoe';

export interface HttpRadiusOrchestratorGatewayOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  /** Inyectable para tests (AxiosInstance fake). En prod se crea internamente. */
  http?: AxiosInstance;
}

/**
 * HttpRadiusOrchestratorGateway — cliente HTTP real del radius-orchestrator (FastAPI, bearer token).
 * Espeja 1:1 la API verificada en vivo (v0.1.0). Cualquier fallo (red/timeout/HTTP error) →
 * `OrchestratorUnreachableError` → la ruta lo mapea a 502 y el use case NO confirma en DB.
 * El token es server-side (config), NUNCA viaja por la capa HTTP de Prominense hacia el browser.
 */
export class HttpRadiusOrchestratorGateway implements RadiusOrchestratorGateway {
  private readonly http: AxiosInstance;
  private readonly target: string;

  constructor(opts: HttpRadiusOrchestratorGatewayOptions) {
    this.target = opts.baseUrl;
    this.http =
      opts.http ??
      axios.create({
        baseURL: opts.baseUrl,
        timeout: opts.timeoutMs ?? 6000,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.token}` },
      });
  }

  private path(username: string, suffix: string): string {
    return `/users/${encodeURIComponent(username)}${suffix}`;
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      // 4xx del orchestrator = petición RECHAZADA deliberadamente (validación, conflicto, etc.)
      // No es un fallo de red; el upstream status + motivo deben llegar al cliente.
      if (isAxiosError(err) && err.response !== undefined && err.response.status >= 400 && err.response.status < 500) {
        throw new OrchestratorRejectedError(err.response.status, err.response.data);
      }
      // Red caída, timeout, 5xx → el orchestrator no respondió correctamente → 502
      throw new OrchestratorUnreachableError(this.target, err instanceof Error ? err.message : String(err));
    }
  }

  async createUser(input: CreateRadiusUserInput): Promise<void> {
    await this.call(() =>
      this.http.post('/users', {
        username: input.username,
        password: input.password,
        plan: input.plan,
        framed_ip: input.framedIp ?? null,
      }),
    );
  }

  async listUsers(): Promise<RadiusUserInventoryItem[]> {
    const { data } = await this.call(() => this.http.get('/users'));
    const rows: unknown = data;
    return (Array.isArray(rows) ? rows : []).map(toInventoryItem);
  }

  async changePlan(username: string, plan: string, opts?: ChangePlanOptions): Promise<void> {
    await this.call(() =>
      this.http.post(this.path(username, '/plan'), { plan, apply_in_session: opts?.applyInSession ?? false }),
    );
  }

  async changePassword(username: string, password: string): Promise<void> {
    await this.call(() => this.http.post(this.path(username, '/password'), { password }));
  }

  async changeFramedIp(username: string, framedIp: string | null): Promise<void> {
    await this.call(() => this.http.post(this.path(username, '/framed-ip'), { framed_ip: framedIp }));
  }

  async suspend(username: string, opts?: SuspendOptions): Promise<void> {
    await this.call(() =>
      this.http.post(this.path(username, '/suspend'), {
        disconnect_active_sessions: opts?.disconnectActiveSessions ?? false,
        reason: opts?.reason ?? null,
      }),
    );
  }

  async reactivate(username: string): Promise<void> {
    await this.call(() => this.http.post(this.path(username, '/reactivate'), {}));
  }

  async listSessions(username: string): Promise<OrchestratorSession[]> {
    const { data } = await this.call(() => this.http.get(this.path(username, '/sessions')));
    const rows: unknown = data;
    return (Array.isArray(rows) ? rows : []).map(toSession);
  }

  async disconnectSessions(username: string): Promise<void> {
    await this.call(() => this.http.delete(this.path(username, '/sessions')));
  }

  async deleteUser(username: string): Promise<void> {
    await this.call(() => this.http.delete(this.path(username, '')));
  }

  async syncPlan(code: string, downloadKbps: number, uploadKbps: number, pool?: string | null): Promise<void> {
    await this.call(() =>
      this.http.put(`/plans/${encodeURIComponent(code)}`, {
        download_kbps: downloadKbps,
        upload_kbps: uploadKbps,
        pool: pool ?? null,
      }),
    );
  }

  async deletePlan(code: string): Promise<void> {
    await this.call(() => this.http.delete(`/plans/${encodeURIComponent(code)}`));
  }

  async listAssignedIps(): Promise<string[]> {
    const { data } = await this.call(() => this.http.get('/assigned-ips'));
    const ips: unknown = (data as { ips?: unknown } | null)?.ips;
    return Array.isArray(ips) ? (ips as string[]) : [];
  }

  async listActiveSessions(offset = 0, limit = 10000): Promise<OrchestratorSession[]> {
    const { data } = await this.call(() =>
      this.http.get('/sessions', { params: { offset, limit } }),
    );
    const rows: unknown = data;
    return (Array.isArray(rows) ? rows : []).map(toSession);
  }

  async listAccounting(filters: ListAccountingFilters): Promise<AccountingPage> {
    // Build query params — omit undefined values so they don't pollute the query string
    // FIX2: usar since_update/until_update (acctupdatetime) en lugar de since_start/until_start
    const params: Record<string, string | number> = {};
    if (filters.sinceUpdate  !== undefined) params['since_update'] = filters.sinceUpdate;
    if (filters.untilUpdate  !== undefined) params['until_update'] = filters.untilUpdate;
    if (filters.username     !== undefined) params['username']     = filters.username;
    if (filters.nasIpAddress !== undefined) params['nasipaddress'] = filters.nasIpAddress;
    if (filters.page         !== undefined) params['page']         = filters.page;
    if (filters.pageSize     !== undefined) params['page_size']    = filters.pageSize;

    const { data } = await this.call(() => this.http.get('/accounting', { params }));
    return toAccountingPage(data);
  }

  async listPostauth(filters: ListPostauthFilters): Promise<PostauthPage> {
    // Build query params — omit undefined values so they don't pollute the query string.
    const params: Record<string, string | number> = {};
    if (filters.sinceAuthdate !== undefined) params['since_authdate'] = filters.sinceAuthdate;
    if (filters.untilAuthdate !== undefined) params['until_authdate'] = filters.untilAuthdate;
    if (filters.username      !== undefined) params['username']       = filters.username;
    if (filters.reply         !== undefined) params['reply']          = filters.reply;
    if (filters.page          !== undefined) params['page']           = filters.page;
    if (filters.pageSize      !== undefined) params['page_size']      = filters.pageSize;

    const { data } = await this.call(() => this.http.get('/postauth', { params }));
    return toPostauthPage(data);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toInventoryItem(r: any): RadiusUserInventoryItem {
  return {
    username: r.username,
    password: r.password,
    plan: r.plan ?? null,
    framedIp: r.framed_ip ?? null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toSession(r: any): OrchestratorSession {
  return {
    sessionId: r.session_id,
    username: r.username,
    nasIp: r.nas_ip,
    framedIp: r.framed_ip ?? null,
    startedAt: r.started_at,
    bytesIn: r.bytes_in ?? 0,
    bytesOut: r.bytes_out ?? 0,
    callerId: r.caller_id ?? null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toAccountingRow(r: any): AccountingEventRow {
  return {
    uniqueId:     r.unique_id,
    username:     r.username,
    nasIpAddress: r.nasipaddress,
    framedIp:     r.framedipaddress ?? null,
    macAddress:   r.callingstationid ?? null,
    vlan:         r.vlan ?? null,
    startedAt:    r.acctstarttime,
    stoppedAt:    r.acctstoptime ?? null,
    sessionTime:  r.acctsessiontime ?? null,
    inOctets:     BigInt(r.acctinputoctets ?? '0'),
    outOctets:    BigInt(r.acctoutputoctets ?? '0'),
    // FIX2: acctupdatetime se actualiza al cerrar la sesion → cursor del ingest
    lastUpdate:   r.acctupdatetime ?? null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toAccountingPage(data: any): AccountingPage {
  const items = Array.isArray(data?.items) ? (data.items as unknown[]).map(toAccountingRow) : [];
  return {
    items,
    page:     data?.page     ?? 1,
    pageSize: data?.page_size ?? 0,
    nextPage: data?.next_page ?? null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toAuthEventRow(r: any): AuthEventRow {
  return {
    // El orchestrator devuelve source_id como NUMBER (radpostauth.id int auto_increment),
    // pero RadiusAuthEvent.sourceUniqueId es String en Prisma. Normalizamos en el BORDE
    // (boundary del JSON externo): sin String() el upsert revienta con
    // "Expected String, provided Int" y la tabla queda en 0.
    sourceId: String(r.source_id),
    username: r.username,
    reply:    r.reply,
    authdate: r.authdate,
    class:    r.class ?? null,
    // Fase 1: el orchestrator devuelve `reason` en rechazos. Ausente (Access-Accept) → null.
    reason:   r.reason ?? null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPostauthPage(data: any): PostauthPage {
  const items = Array.isArray(data?.items) ? (data.items as unknown[]).map(toAuthEventRow) : [];
  return {
    items,
    page:     data?.page     ?? 1,
    pageSize: data?.page_size ?? 0,
    nextPage: data?.next_page ?? null,
  };
}
