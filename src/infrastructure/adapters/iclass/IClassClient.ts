import axios, { AxiosInstance } from 'axios';
import { IClassPort, IClassNode, CreateServiceOrderInput } from '@domain/ports/IClassPort';
import { IClassUnavailableError } from '@domain/errors/iclass';

export interface IClassClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  thirdPartyId: string;
  /** Fixed typeSOSummary applied to every OS (AD-4). */
  defaultSoType: string;
  timeoutMs?: number;
  /** TTL for the in-memory listNodes() cache (AD-2). Default 5 min. */
  nodesCacheTtlMs?: number;
  /** Injectable HTTP client for deterministic tests. */
  http?: AxiosInstance;
  /** Injectable clock for deterministic openedDate tests. */
  now?: () => Date;
}

/** Minimal shape of an axios-style transport error. */
function isAxiosLikeError(e: unknown): e is { response?: { status?: number } } {
  return typeof e === 'object' && e !== null && 'isAxiosError' in e;
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
  private readonly defaultSoType: string;
  private readonly now: () => Date;
  private readonly nodesCacheTtlMs: number;

  private token: string | null = null;
  private nodesCache: { nodes: IClassNode[]; expiresAt: number } | null = null;

  constructor(opts: IClassClientOptions) {
    this.username = opts.username;
    this.password = opts.password;
    this.thirdPartyId = opts.thirdPartyId;
    this.defaultSoType = opts.defaultSoType;
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

  async createServiceOrder(input: CreateServiceOrderInput): Promise<{ orderCode: string }> {
    const payload = this.buildServiceOrderPayload(input);
    const data = await this.authedPost<{ codigoOS?: string | null; erros?: unknown }>(
      '/serviceorders',
      payload,
    );
    if (data.erros !== null && data.erros !== undefined) {
      throw new IClassUnavailableError(`IClass rejected the service order: ${String(data.erros)}`);
    }
    const orderCode = data.codigoOS;
    if (!orderCode) {
      throw new IClassUnavailableError('IClass did not return an order code');
    }
    return { orderCode: String(orderCode) };
  }

  /** Build the ServiceOrderV1In payload. nodeCode = city, NO scheduledDate (REQ-OS-1, AD-5). */
  private buildServiceOrderPayload(input: CreateServiceOrderInput) {
    const stamp = `${input.customerCode}-${this.now().getTime()}`;
    return {
      serviceOrder: {
        soCode: stamp,
        customerCode: input.customerCode,
        addressCode: stamp,
        typeSOSummary: this.defaultSoType,
        openedDate: formatOpenedDate(this.now()),
        observation: input.description,
      },
      customer: {
        customerCode: input.customerCode,
        name: input.customerName,
      },
      address: {
        addressCode: stamp,
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
    if (e instanceof IClassUnavailableError) return e;
    if (isAxiosLikeError(e)) {
      const status = e.response?.status;
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
