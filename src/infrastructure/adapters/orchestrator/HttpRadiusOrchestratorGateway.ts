import axios, { AxiosInstance, isAxiosError } from 'axios';
import {
  RadiusOrchestratorGateway,
  OrchestratorSession,
  ChangePlanOptions,
  SuspendOptions,
  CreateRadiusUserInput,
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

  async changePlan(username: string, plan: string, opts?: ChangePlanOptions): Promise<void> {
    await this.call(() =>
      this.http.post(this.path(username, '/plan'), { plan, apply_in_session: opts?.applyInSession ?? false }),
    );
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
  };
}
