import axios, { AxiosInstance } from 'axios';
import { IClassPort, IClassNode, IClassSoTypeDescriptor, CreateServiceOrderInput } from '@domain/ports/IClassPort';
import { IClassUnavailableError, IClassRejectedError } from '@domain/errors/iclass';

export interface IClassClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  thirdPartyId: string;
  timeoutMs?: number;
  /** TTL for the in-memory listNodes() cache (AD-2). Default 5 min. */
  nodesCacheTtlMs?: number;
  /** Injectable HTTP client for deterministic tests. */
  http?: AxiosInstance;
  /** Injectable clock for deterministic openedDate tests. */
  now?: () => Date;
}

/** Minimal shape of an axios-style transport error. */
function isAxiosLikeError(e: unknown): e is { response?: { status?: number; data?: { erros?: unknown } } } {
  return typeof e === 'object' && e !== null && 'isAxiosError' in e;
}

/**
 * Serialize IClass `erros` to a human-readable string. Each error is `code: description`,
 * joined by "; ". Falls back to String() for unexpected shapes. Never leaks raw JSON
 * across the layer boundary — the result is a plain string carried by the domain error.
 */
function formatIClassErrors(erros: unknown): string {
  if (Array.isArray(erros)) {
    return erros
      .map(e => {
        if (e && typeof e === 'object') {
          const o = e as { code?: unknown; description?: unknown };
          const code = o.code != null ? String(o.code) : '';
          const desc = o.description != null ? String(o.description) : '';
          return code && desc ? `${code}: ${desc}` : code || desc || String(e);
        }
        return String(e);
      })
      .join('; ');
  }
  return String(erros);
}

/**
 * Adapter for the IClass v2 external API.
 *
 * Auth is Bearer: POST /auth/login {username,password} → { access_token }.
 * The token is attached to every subsequent call; on a 401 the adapter
 * re-logs in once and retries the original request. Transport failures (5xx,
 * connection errors, persistent 401) are translated to IClassUnavailableError
 * so callers never see a raw axios error. Responses are mapped to the port's
 * types — raw IClass JSON never crosses the layer boundary (REQ-OS-4).
 */
export class IClassClient implements IClassPort {
  private readonly http: AxiosInstance;
  private readonly username: string;
  private readonly password: string;
  private readonly thirdPartyId: string;
  private readonly now: () => Date;
  private readonly nodesCacheTtlMs: number;

  private token: string | null = null;
  private nodesCache: { nodes: IClassNode[]; expiresAt: number } | null = null;

  constructor(opts: IClassClientOptions) {
    this.username = opts.username;
    this.password = opts.password;
    this.thirdPartyId = opts.thirdPartyId;
    this.now = opts.now ?? (() => new Date());
    this.nodesCacheTtlMs = opts.nodesCacheTtlMs ?? 5 * 60 * 1000;
    this.http =
      opts.http ??
      axios.create({
        baseURL: opts.baseUrl,
        timeout: opts.timeoutMs ?? 30000,
        headers: { 'Content-Type': 'application/json' },
      });
  }

  async listNodes(): Promise<IClassNode[]> {
    const now = this.now().getTime();
    if (this.nodesCache && this.nodesCache.expiresAt > now) {
      return this.nodesCache.nodes;
    }
    const data = await this.authedGet<{ objects?: Array<{ codigo?: string; descricao?: string }> }>(
      `/thirdparties/${this.thirdPartyId}/nodes?pagesize=100`,
    );
    const nodes: IClassNode[] = (data.objects ?? []).map(o => ({
      code: String(o.codigo ?? ''),
      description: String(o.descricao ?? ''),
    }));
    this.nodesCache = { nodes, expiresAt: now + this.nodesCacheTtlMs };
    return nodes;
  }

  /**
   * Fetches the SO type catalog for the configured thirdParty.
   * GET /thirdparties/{thirdPartyId}/serviceorders/types?pagesize=200
   * Maps IClass `objects[]` → [{ code: trim(codigo), description: trim(descricao) }].
   * Filters out entries with an empty code after trimming (defensive).
   */
  async listServiceOrderTypes(): Promise<IClassSoTypeDescriptor[]> {
    const data = await this.authedGet<{ objects?: Array<{ codigo?: unknown; descricao?: unknown }> }>(
      `/thirdparties/${this.thirdPartyId}/serviceorders/types?pagesize=200`,
    );
    return (data.objects ?? [])
      .map(o => ({
        code: String(o.codigo ?? '').trim(),
        description: String(o.descricao ?? '').trim(),
      }))
      .filter(t => t.code.length > 0);
  }

  async createServiceOrder(input: CreateServiceOrderInput): Promise<{ orderCode: string }> {
    // REQ-PORT-2: adapter has no default SO type. callers MUST resolve soType from
    // the Project mapping before calling. Empty/whitespace is a programmer error.
    if (!input.soType || !input.soType.trim()) {
      throw new Error('soType is required');
    }
    const payload = this.buildServiceOrderPayload(input);
    const data = await this.authedPost<{ codigoOS?: string | null; erros?: unknown }>(
      '/serviceorders',
      payload,
    );
    if (data.erros !== null && data.erros !== undefined) {
      throw new IClassRejectedError(formatIClassErrors(data.erros));
    }
    const orderCode = data.codigoOS;
    if (!orderCode) {
      throw new IClassUnavailableError('IClass did not return an order code');
    }
    return { orderCode: String(orderCode) };
  }

  /** Build the ServiceOrderV1In payload. nodeCode = city, NO scheduledDate (REQ-OS-1, AD-5). */
  private buildServiceOrderPayload(input: CreateServiceOrderInput) {
    // soCode/addressCode carry the task sequenceNumber: short, unique per task, and
    // lets us correlate the IClass OS back to the backend task. IClass enforces a char
    // limit on these codes (ICLERR_0050); the sequenceNumber stays well within it.
    const soCode = input.soCode;
    return {
      serviceOrder: {
        soCode,
        customerCode: input.customerCode,
        addressCode: soCode,
        typeSOSummary: input.soType,
        openedDate: formatOpenedDate(this.now()),
        observation: input.description,
      },
      customer: {
        customerCode: input.customerCode,
        name: input.customerName,
        mobile: input.phone,
      },
      address: {
        addressCode: soCode,
        customerCode: input.customerCode,
        address: input.address,
        number: '',
        city: input.city,
        state: '',
        country: '',
        zipCode: '',
        nodeCode: input.city,
        neighborhood: '',
      },
    };
  }

  private async login(): Promise<void> {
    try {
      const res = await this.http.post('/auth/login', {
        username: this.username,
        password: this.password,
      });
      const token = (res?.data as { access_token?: string } | undefined)?.access_token;
      if (!token) throw new IClassUnavailableError('IClass login returned no access_token');
      this.token = token;
    } catch (e) {
      throw this.mapError(e);
    }
  }

  private authHeaders() {
    return { Authorization: `Bearer ${this.token}` };
  }

  /** Ensure we have a token, run `fn`, and on a 401 re-login once and retry. */
  private async withAuthRetry<T>(fn: () => Promise<{ data: T }>): Promise<T> {
    if (!this.token) await this.login();
    try {
      const res = await fn();
      return res.data;
    } catch (e) {
      if (isAxiosLikeError(e) && e.response?.status === 401) {
        // Re-login once and retry the original call.
        await this.login();
        try {
          const res = await fn();
          return res.data;
        } catch (e2) {
          throw this.mapError(e2);
        }
      }
      throw this.mapError(e);
    }
  }

  private authedGet<T>(url: string): Promise<T> {
    return this.withAuthRetry<T>(() => this.http.get(url, { headers: this.authHeaders() }));
  }

  private authedPost<T>(url: string, body: unknown): Promise<T> {
    return this.withAuthRetry<T>(() => this.http.post(url, body, { headers: this.authHeaders() }));
  }

  /** Translate transport errors to a domain error. Never leak axios cross-layer. */
  private mapError(e: unknown): Error {
    if (e instanceof IClassUnavailableError || e instanceof IClassRejectedError) return e;
    if (isAxiosLikeError(e)) {
      const status = e.response?.status;
      // HTTP 400 carrying business `erros` is an explicit rejection, not an outage.
      const erros = e.response?.data?.erros;
      if (status === 400 && erros !== null && erros !== undefined) {
        return new IClassRejectedError(formatIClassErrors(erros));
      }
      return new IClassUnavailableError(
        status ? `IClass responded with HTTP ${status}` : 'IClass connection failed',
      );
    }
    return new IClassUnavailableError();
  }
}

/** Date → "yyyy-MM-dd HH:mm:ss -0300" (IClass openedDate format). */
export function formatOpenedDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} -0300`
  );
}
