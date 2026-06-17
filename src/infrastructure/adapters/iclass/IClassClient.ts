import axios, { AxiosInstance } from 'axios';
import {
  IClassPort,
  IClassNodeDescriptor,
  IClassSoTypeDescriptor,
  IClassResultCodeDescriptor,
  CreateServiceOrderInput,
  ListServiceOrdersParams,
  ServiceOrderSnapshot,
  CloseServiceOrderInput,
  IClassTeamDescriptor,
  UpdateServiceOrderInput,
} from '@domain/ports/IClassPort';
import {
  ClosedServiceOrderSummary,
  SoStatusHistoryEntry,
  SoChecklist,
  SoMaterial,
  SoEquipmentEvent,
} from '@domain/entities/iclass-closed-order';
import { IClassUnavailableError, IClassRejectedError } from '@domain/errors/iclass';

/** Default cluster — the only IPNEXT cluster in IClass. */
const DEFAULT_CLUSTER = 'IPNEXT INTERNET';
/** Backoff between sub-resource calls to dodge the "Espere um pouco" rate limit. */
const SUBRESOURCE_BACKOFF_MS = 400;
/** Window (days) scanned over recent SOs to discover active soType ids for the
 * result-code catalog sync. Under the IClass 30-day list cap. */
const RESULT_CODE_DISCOVERY_DAYS = 28;
/** Máximo de reintentos ante un HTTP 429 (rate-limit de estado). */
const MAX_RATE_LIMIT_RETRIES = 4;

export interface IClassClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  thirdPartyId: string;
  /** IClass cluster name, required on /serviceorders queries. Default "IPNEXT INTERNET". */
  clusterName?: string;
  timeoutMs?: number;
  /** TTL for the in-memory listNodes() cache (AD-2). Default 5 min. */
  nodesCacheTtlMs?: number;
  /** Injectable HTTP client for deterministic tests. */
  http?: AxiosInstance;
  /** Injectable clock for deterministic openedDate tests. */
  now?: () => Date;
  /** Override backoff for tests (default 400ms). */
  subresourceBackoffMs?: number;
  /** Límite de reintentos ante HTTP 429. Default MAX_RATE_LIMIT_RETRIES (4). */
  maxRateLimitRetries?: number;
  /** Función sleep inyectable para tests (elimina waits reales). */
  _sleep?: (ms: number) => Promise<void>;
}

/** Minimal shape of an axios-style transport error. */
function isAxiosLikeError(e: unknown): e is {
  response?: { status?: number; headers?: Record<string, unknown>; data?: { erros?: unknown } };
} {
  return typeof e === 'object' && e !== null && 'isAxiosError' in e;
}

/**
 * Extrae el tiempo de espera en ms del header `Retry-After` (sólo enteros en segundos).
 * Formas de fecha HTTP y valores no numéricos son ignorados → undefined.
 */
export function parseRetryAfterMs(e: unknown): number | undefined {
  if (!isAxiosLikeError(e)) return undefined;
  const raw = e.response?.headers?.['retry-after'];
  if (raw === null || raw === undefined) return undefined;
  const seconds = parseInt(String(raw), 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return seconds * 1000;
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
  private readonly clusterName: string;
  private readonly subresourceBackoffMs: number;
  private readonly maxRateLimitRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly nodesCacheTtlMs: number;

  private token: string | null = null;
  private nodesCache: { nodes: IClassNodeDescriptor[]; expiresAt: number } | null = null;

  constructor(opts: IClassClientOptions) {
    this.username = opts.username;
    this.password = opts.password;
    this.thirdPartyId = opts.thirdPartyId;
    this.clusterName = opts.clusterName ?? DEFAULT_CLUSTER;
    this.subresourceBackoffMs = opts.subresourceBackoffMs ?? SUBRESOURCE_BACKOFF_MS;
    this.maxRateLimitRetries = opts.maxRateLimitRetries ?? MAX_RATE_LIMIT_RETRIES;
    this.sleep = opts._sleep ?? sleep;
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

  async listNodes(): Promise<IClassNodeDescriptor[]> {
    const now = this.now().getTime();
    if (this.nodesCache && this.nodesCache.expiresAt > now) {
      return this.nodesCache.nodes;
    }
    // Shape verificado live 2026-06-11 contra api-v2.iclass.com.br: el id viene como
    // `nodeId` (inglés) conviviendo con `codigo`/`descricao` (portugués) en el mismo
    // objeto. La API es inconsistente a propósito — NO "corregir" nodeId a un nombre pt.
    const data = await this.authedGet<{
      objects?: Array<{ nodeId?: unknown; codigo?: string; descricao?: string }>;
    }>(`/thirdparties/${this.thirdPartyId}/nodes?pagesize=100`);
    const nodes: IClassNodeDescriptor[] = (data.objects ?? []).map(o => ({
      nodeId: Number(o.nodeId ?? 0),
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

  // ── Closure loop (read path) ──────────────────────────────────────────────

  async listServiceOrders(params: ListServiceOrdersParams): Promise<ClosedServiceOrderSummary[]> {
    const base = new URLSearchParams({
      clusterName: this.clusterName,
      updatedDate_begin: formatListDate(params.updatedDateBegin),
      updatedDate_end: formatListDate(params.updatedDateEnd),
      pagesize: '60',
    });
    if (params.serviceOrderCode) base.set('serviceOrderCode', params.serviceOrderCode);
    const raw = await this.fetchAllPages(`/serviceorders`, base);
    return raw.map(o => parseServiceOrderSummary(o, this.clusterName));
  }

  async getServiceOrderHistory(iclassId: string): Promise<SoStatusHistoryEntry[]> {
    const raw = await this.fetchAllPages(`/serviceorders/${iclassId}/history`, new URLSearchParams({ pagesize: '60' }));
    return raw.map(parseHistoryEntry);
  }

  async getServiceOrderChecklists(iclassId: string): Promise<SoChecklist[]> {
    const raw = await this.fetchAllPages(`/serviceorders/${iclassId}/checklist`, new URLSearchParams({ pagesize: '60' }));
    return raw.map(parseChecklist);
  }

  async getServiceOrderMaterials(iclassId: string): Promise<SoMaterial[]> {
    const raw = await this.fetchAllPages(`/serviceorders/${iclassId}/materials`, new URLSearchParams({ pagesize: '60' }));
    return raw.map(parseMaterial);
  }

  async getServiceOrderEquipmentEvents(iclassId: string): Promise<SoEquipmentEvent[]> {
    const raw = await this.fetchAllPages(`/serviceorders/${iclassId}/equipments/history`, new URLSearchParams({ pagesize: '60' }));
    return raw.map(parseEquipmentEvent);
  }

  async listResultCodes(): Promise<IClassResultCodeDescriptor[]> {
    // The SO-type list endpoints expose NO numeric id (verified live): neither
    // /thirdparties/{tp}/serviceorders/types nor /serviceordertypes?thirdPartyId
    // return it, and their `motivosFechamento` is empty in list view. The numeric
    // soType id only appears as `tipoOs.id` on the SO list. So we discover the
    // active soType ids from recent SOs, then fan out to each type's result codes
    // (/serviceordertypes/{id}/resultcodes), which IS populated.
    const now = this.now();
    const begin = new Date(now.getTime() - RESULT_CODE_DISCOVERY_DAYS * 24 * 60 * 60 * 1000);
    const sos = await this.fetchAllPages(
      '/serviceorders',
      new URLSearchParams({
        clusterName: this.clusterName,
        updatedDate_begin: formatListDate(begin),
        updatedDate_end: formatListDate(now),
        pagesize: '60',
      }),
    );

    const soTypeIds = new Set<string>();
    for (const o of sos) {
      const tipoOs = (o as { tipoOs?: { id?: unknown } }).tipoOs;
      if (tipoOs?.id != null) soTypeIds.add(String(tipoOs.id));
    }

    const out: IClassResultCodeDescriptor[] = [];
    const seen = new Set<string>();
    for (const id of soTypeIds) {
      await this.sleep(this.subresourceBackoffMs);
      const codes = await this.fetchAllPages(
        `/serviceordertypes/${id}/resultcodes`,
        new URLSearchParams({ pagesize: '100' }),
      );
      for (const c of codes) {
        const desc = parseResultCode(c, id);
        const key = `${id}::${desc.code}`;
        if (desc.code && !seen.has(key)) {
          seen.add(key);
          out.push(desc);
        }
      }
    }
    return out;
  }

  /**
   * GET a paginated IClass list resource, following pages while hasMoreElements.
   * Treats 204 (empty body) as an empty list and retries once on the textual
   * "Espere um pouco" rate-limit response.
   */
  private async fetchAllPages(path: string, params: URLSearchParams): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let page = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      params.set('pagenumber', String(page));
      let data = await this.authedGet<unknown>(`${path}?${params.toString()}`);
      if (isRateLimited(data)) {
        await this.sleep(this.subresourceBackoffMs * 2);
        data = await this.authedGet<unknown>(`${path}?${params.toString()}`);
      }
      if (!data || typeof data !== 'object') break; // 204 / empty / rate-limited text
      const body = data as { objects?: unknown[]; hasMoreElements?: boolean };
      const objects = Array.isArray(body.objects) ? body.objects : [];
      for (const o of objects) if (o && typeof o === 'object') out.push(o as Record<string, unknown>);
      if (!body.hasMoreElements || objects.length === 0) break;
      page++;
    }
    return out;
  }

  /** Build the ServiceOrderV1In payload. nodeCode = city, NO scheduledDate (REQ-OS-1, AD-5). */
  private buildServiceOrderPayload(input: CreateServiceOrderInput) {
    // #121 — soCode and addressCode are now DISTINCT keys:
    //   - soCode      = input.soCode (task sequenceNumber): UNIQUE PER OS, the closure
    //                   matching key (SO.codigo == sequenceNumber).
    //   - addressCode = input.addressCode (contract / node code): STABLE across OS of
    //                   the same contract/node, so N OS share ONE IClass address instead
    //                   of creating a new address per OS.
    // IClass enforces a char limit on these codes (ICLERR_0050); both stay within it.
    const soCode = input.soCode;
    const addressCode = input.addressCode;
    return {
      serviceOrder: {
        soCode,
        customerCode: input.customerCode,
        addressCode,
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
        addressCode,
        customerCode: input.customerCode,
        address: input.address,
        number: '',
        city: input.city,
        state: '',
        country: '',
        zipCode: '',
        nodeCode: input.nodeCode ?? input.city,
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

  /**
   * Ejecuta `fn` con reintento automático ante 401 (re-login una vez) y ante
   * 429 (espera Retry-After o backoff exponencial, hasta maxRateLimitRetries).
   * Tras agotar reintentos 429 o ante cualquier otro error, delega a mapError.
   *
   * IMPORTANTE: el re-login 401 sólo se ejecuta en attempt===0 para no
   * interferir con el loop 429.
   */
  private async withAuthRetry<T>(fn: () => Promise<{ data: T }>): Promise<T> {
    if (!this.token) await this.login();

    for (let attempt = 0; attempt <= this.maxRateLimitRetries; attempt++) {
      try {
        const res = await fn();
        return res.data;
      } catch (e) {
        // 401 → re-login una única vez (sólo en el primer intento)
        if (isAxiosLikeError(e) && e.response?.status === 401 && attempt === 0) {
          await this.login();
          continue;
        }

        // 429 → esperar y reintentar mientras queden intentos
        if (isAxiosLikeError(e) && e.response?.status === 429 && attempt < this.maxRateLimitRetries) {
          const ms = parseRetryAfterMs(e) ?? this.subresourceBackoffMs * Math.pow(2, attempt);
          await this.sleep(ms);
          continue;
        }

        // Sin reintentos disponibles o error de otro tipo → propagar
        throw this.mapError(e);
      }
    }

    // Nunca debería llegar acá (el loop siempre retorna o lanza), pero TypeScript lo requiere.
    throw this.mapError(new Error('withAuthRetry: loop exhausted unexpectedly'));
  }

  // ── Ola A: getServiceOrder + closeServiceOrder ─────────────────────────────

  /**
   * Fetch the current state of a single Service Order for the live pre-check.
   * Returns null when IClass responds 404 or 204 (OS unknown to IClass).
   * Passes through withAuthRetry (429-resilient via authedGetOrNull).
   * AD-5: reuses parseServiceOrderSummary — same shape as list endpoint.
   *
   * IMPORTANT: a rate-limit-200 ("Espere um pouco") must NEVER return null.
   * Returning null would be interpreted as "OS not found" — a silent corruption.
   * Instead, isRateLimited is checked first and throws IClassUnavailableError.
   */
  async getServiceOrder(iclassId: string): Promise<ServiceOrderSnapshot | null> {
    // authedGetOrNull handles 404 → null and rate-limit-200 → IClassUnavailableError.
    const raw = await this.authedGetOrNull(`/serviceorders/${iclassId}`);
    if (!raw || typeof raw !== 'object') return null;
    const summary = parseServiceOrderSummary(raw as Record<string, unknown>, this.clusterName);
    return {
      iclassId: summary.iclassId,
      iclassCodigo: summary.iclassCodigo,
      statusCode: summary.statusCode,
      statusDescription: summary.statusDescription,
    };
  }

  /**
   * Push a close action to IClass via POST /serviceorders/close.
   * AD-4: any unexpected response shape → IClassUnavailableError (never a silent success).
   * AD-2: dumb transport — all inputs are pre-resolved by the use case.
   *
   * Success is only accepted when the body is a recognizable object with erros=null/undefined.
   * Any other shape (string, null, HTML, {}) is rejected as IClassUnavailableError.
   * // TODO: confirmar el token de éxito real en la prueba en vivo (§10)
   */
  async closeServiceOrder(input: CloseServiceOrderInput): Promise<void> {
    const payload = {
      serviceOrderCode: input.serviceOrderCode,
      resultCode: input.resultCode,
      closeDate: formatCloseDate(input.closeDate),
      commentary: input.commentary,
      visibleToCustomer: input.visibleToCustomer ?? true,
    };
    const data = await this.authedPost<unknown>('/serviceorders/close', payload);

    // FIX 1: rate-limit-200 disguised as a successful response.
    if (isRateLimited(data)) {
      throw new IClassUnavailableError('IClass rate-limited (Espere um pouco) on close');
    }
    // FIX 2: AD-4 — only a recognizable object response is accepted as success.
    // Strings, null, HTML, and empty {} lack the `erros` key that signals a proper response.
    if (!data || typeof data !== 'object') {
      throw new IClassUnavailableError('IClass close returned unexpected non-object body');
    }
    const typed = data as { erros?: unknown };
    // `erros` key present (even if null) = proper IClass response shape.
    if (!('erros' in typed)) {
      throw new IClassUnavailableError('IClass close returned unrecognized response shape');
    }
    if (typed.erros !== null && typed.erros !== undefined) {
      throw new IClassRejectedError(formatIClassErrors(typed.erros));
    }
    // erros === null → explicit success.
  }

  // ── Ola B: listTeams + updateServiceOrder ─────────────────────────────────

  /**
   * Fetch the team catalog from IClass (`GET /teams` with thirdPartyId filter).
   * Maps each entry to IClassTeamDescriptor; filters empty login (same as node sync).
   */
  async listTeams(): Promise<IClassTeamDescriptor[]> {
    const data = await this.authedGet<{
      // IClass returns the team name in `nome` (Portuguese); keep `name` as fallback (#128).
      objects?: Array<{ login?: unknown; nome?: unknown; name?: unknown; thirdPartyCode?: unknown }>
    }>(`/teams?thirdPartyId=${this.thirdPartyId}&pagesize=200`);
    return (data.objects ?? [])
      .map(o => ({
        login: String(o.login ?? '').trim(),
        name: String(o.nome ?? o.name ?? '').trim(),
        thirdPartyCode: o.thirdPartyCode != null ? String(o.thirdPartyCode).trim() : null,
      }))
      .filter(t => t.login.length > 0);
  }

  /**
   * Update a Service Order in IClass (assign team + schedule window).
   * POST /serviceorders/update with nested soScheduleUpdateIn payload.
   *
   * Verified live 2026-06-18: the flat requiredTeam at the root is silently
   * ignored by IClass. The ONLY way to assign a cuadrilla is via the nested
   * soScheduleUpdateIn shape with scheduleDetails.requiredTeamLogins.
   *
   * The UPDATE endpoint returns ENGLISH keys (success/errors), NOT Portuguese
   * (sucesso/erros) like the close endpoint. These are distinct response shapes.
   */
  async updateServiceOrder(input: UpdateServiceOrderInput): Promise<void> {
    const scheduleDate = formatScheduleDate(input.scheduleStart);
    const finishDate = formatScheduleDate(input.scheduleEnd);
    const payload = {
      serviceOrderCode: input.serviceOrderCode,
      soScheduleUpdateIn: {
        soCode: input.serviceOrderCode,
        scheduleDate,
        requiredTeam: [input.requiredTeam],
        scheduleDetails: {
          requiredTeamLogins: [input.requiredTeam],
          scheduleLimits: {
            start: scheduleDate,
            finish: finishDate,
          },
        },
      },
    };
    const data = await this.authedPost<unknown>('/serviceorders/update', payload);

    // FIX 1: rate-limit-200 disguised as a successful response.
    if (isRateLimited(data)) {
      throw new IClassUnavailableError('IClass rate-limited (Espere um pouco) on update');
    }
    // The UPDATE endpoint uses ENGLISH keys: { success: boolean, errors: [...] }
    // (the CLOSE endpoint uses Portuguese erros — do NOT change close).
    if (!data || typeof data !== 'object') {
      throw new IClassUnavailableError('IClass update returned unexpected non-object body');
    }
    const typed = data as { success?: unknown; errors?: unknown };
    if (typed.success === true) {
      // Explicit success.
      return;
    }
    if (Array.isArray(typed.errors) && typed.errors.length > 0) {
      throw new IClassRejectedError(formatIClassErrors(typed.errors));
    }
    // Neither success:true nor errors array — unrecognized shape (AD-4).
    throw new IClassUnavailableError('IClass update returned unrecognized response shape');
  }

  private authedGet<T>(url: string): Promise<T> {
    return this.withAuthRetry<T>(() => this.http.get(url, { headers: this.authHeaders() }));
  }

  /**
   * Like authedGet but returns null instead of throwing when IClass responds 404.
   * Used by getServiceOrder to map "unknown OS" to null without the 404 becoming
   * IClassUnavailableError (which withAuthRetry's mapError would do).
   *
   * FIX 1: rate-limit-200 ("Espere um pouco") is detected BEFORE the null-return
   * path. A rate-limit must NEVER be interpreted as "OS not found" — it throws
   * IClassUnavailableError after exhausting backoff retries.
   *
   * FIX 4: unified 429/401 retry logic reused from withAuthRetry loop (no duplication).
   */
  private async authedGetOrNull(url: string): Promise<unknown | null> {
    if (!this.token) await this.login();
    for (let attempt = 0; attempt <= this.maxRateLimitRetries; attempt++) {
      try {
        const res = await this.http.get(url, { headers: this.authHeaders() });
        const data = (res as { data?: unknown }).data ?? null;

        // FIX 1: rate-limit disguised as HTTP 200 — retry with backoff.
        if (isRateLimited(data)) {
          if (attempt < this.maxRateLimitRetries) {
            await this.sleep(this.subresourceBackoffMs * Math.pow(2, attempt));
            continue;
          }
          throw new IClassUnavailableError('IClass rate-limited (Espere um pouco) on getServiceOrder');
        }

        return data;
      } catch (e) {
        if (e instanceof IClassUnavailableError) throw e;
        // 404 → null (OS unknown to IClass)
        if (isAxiosLikeError(e) && e.response?.status === 404) return null;
        // 401 → re-login once
        if (isAxiosLikeError(e) && e.response?.status === 401 && attempt === 0) {
          await this.login();
          continue;
        }
        // 429 → backoff retry (FIX 4: same logic as withAuthRetry, not duplicated inline)
        if (isAxiosLikeError(e) && e.response?.status === 429 && attempt < this.maxRateLimitRetries) {
          const ms = parseRetryAfterMs(e) ?? this.subresourceBackoffMs * Math.pow(2, attempt);
          await this.sleep(ms);
          continue;
        }
        throw this.mapError(e);
      }
    }
    throw this.mapError(new Error('authedGetOrNull: loop exhausted'));
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

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Date → "dd-MM-yyyy HH:mm" (IClass /serviceorders date-filter format). */
export function formatListDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** IClass returns its rate-limit notice as a 200 with a plain-text body. */
export function isRateLimited(data: unknown): boolean {
  return typeof data === 'string' && /espere um pouco/i.test(data);
}

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse an IClass date into an ISO-8601 string (Buenos Aires, -03:00), or null.
 * Handles "dd-MM-yyyy HH:mm:ss", "dd-MM-yyyy HH:mm", and passes through ISO inputs
 * (checklist `dataPesquisa` already comes as ISO with offset).
 */
export function parseIClassDate(v: unknown): string | null {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const s = v.trim();
  if (s.includes('T')) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [, dd, MM, yyyy, hh = '00', mi = '00', ss = '00'] = m;
  const d = new Date(`${yyyy}-${MM}-${dd}T${hh}:${mi}:${ss}-03:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** Map a raw IClass SO (list/detail share the shape) → normalized summary. */
export function parseServiceOrderSummary(raw: Record<string, unknown>, clusterName: string): ClosedServiceOrderSummary {
  const contrato = obj(raw.contrato);
  const endereco = obj(raw.endereco);
  const node = obj(raw.node);
  const equipe = obj(raw.equipe);
  const tipoOs = obj(raw.tipoOs);
  const status = obj(raw.status);
  const criadoPor = obj(raw.criadoPor);
  const alteradoPor = obj(raw.alteradoPor);
  const credenciada = obj(raw.credenciada);
  const coords = obj(raw.coordenadasFechamento);
  return {
    iclassId: String(raw.id ?? ''),
    iclassCodigo: String(raw.codigo ?? ''),
    clusterName,
    thirdPartyCode: strOrNull(credenciada.codigo),
    nodeCode: strOrNull(node.codigo),
    soTypeId: strOrNull(tipoOs.id),
    soTypeDescription: strOrNull(tipoOs.resumoTipoOs) ?? strOrNull(tipoOs.descricao),
    customerCode: strOrNull(contrato.codigo),
    customerName: strOrNull(contrato.nomeTitular),
    addressCode: strOrNull(endereco.codigo),
    addressLine: strOrNull(endereco.logradouro),
    addressCity: strOrNull(endereco.cidade),
    addressLat: numOrNull(endereco.latitude),
    addressLng: numOrNull(endereco.longitude),
    statusCode: String(status.id ?? ''),
    statusDescription: String(status.descricao ?? ''),
    requestedAt: parseIClassDate(raw.dataSolicitacao),
    scheduledFor: parseIClassDate(raw.dataAgendamento),
    availableAt: parseIClassDate(raw.dataDisponibilidade),
    serviceStartedAt: parseIClassDate(raw.dataInicioAtendimento),
    serviceEndedAt: parseIClassDate(raw.dataFimAtendimento),
    resultCodeName: strOrNull(raw.motivoFechamento),
    closedByLogin: strOrNull(alteradoPor.login),
    closedByName: strOrNull(alteradoPor.nome),
    closeLatitude: numOrNull(coords.latitude),
    closeLongitude: numOrNull(coords.longitude),
    closeGpsAt: parseIClassDate(coords.dataRegistro),
    billingAmount: numOrNull(raw.valorCobranca),
    technicianNote: strOrNull(raw.obsEquipe),
    internalNote: strOrNull(raw.obs),
    commentaryLog: strOrNull(raw.comentario),
    teamLogin: strOrNull(equipe.login),
    teamTechnicianName: strOrNull(equipe.tecnico),
    teamPhone: strOrNull(equipe.fone1),
    teamEmail: strOrNull(equipe.email),
    iclassCreatedAt: parseIClassDate(criadoPor.data),
    iclassUpdatedAt: parseIClassDate(alteradoPor.data),
    rawDetail: raw,
  };
}

export function parseHistoryEntry(raw: Record<string, unknown>): SoStatusHistoryEntry {
  const statusOS = obj(raw.statusOS);
  const equipe = obj(raw.equipeDTO);
  return {
    iclassOsStatusId: String(raw.osStatusId ?? ''),
    occurredAt: parseIClassDate(raw.data),
    statusCode: String(statusOS.codigo ?? ''),
    statusDescription: String(statusOS.descricao ?? ''),
    durationMinutes: numOrNull(raw.tempoStatus),
    teamLogin: strOrNull(equipe.login),
    commentary: strOrNull(raw.comentario),
  };
}

export function parseChecklist(raw: Record<string, unknown>): SoChecklist {
  const perguntas = Array.isArray(raw.perguntas) ? (raw.perguntas as Record<string, unknown>[]) : [];
  return {
    iclassSurveyId: String(raw.pesquisaId ?? ''),
    surveyAt: parseIClassDate(raw.dataPesquisa),
    answers: perguntas.map((p, i) => {
      const r = obj(p.resposta);
      const questionType = String(r.tipoPergunta ?? '');
      return {
        questionId: p.pesqPerguntaId != null ? String(p.pesqPerguntaId) : null,
        questionText: String(p.pergunta ?? ''),
        questionType,
        answerOrder: numOrNull(r.ordem) ?? i,
        answerText: strOrNull(r.resposta),
        photoMissing: questionType === 'Foto',
        photoUrl: null, // API v2 is photo-blind; set later by the SEAM correlation
      };
    }),
  };
}

export function parseMaterial(raw: Record<string, unknown>): SoMaterial {
  return {
    iclassOsMaterialId: String(raw.id ?? raw.osMaterialId ?? ''),
    materialCode: strOrNull(raw.codigo ?? raw.materialCode),
    materialDescription: strOrNull(raw.descricao ?? raw.materialDescription),
    qty: numOrNull(raw.quantidade ?? raw.qty) ?? 0,
    unitValue: numOrNull(raw.valorUnitario ?? raw.unitValue),
    totalValue: numOrNull(raw.valorTotal ?? raw.totalValue),
  };
}

export function parseEquipmentEvent(raw: Record<string, unknown>): SoEquipmentEvent {
  return {
    occurredAt: parseIClassDate(raw.data ?? raw.occurredAt),
    type: strOrNull(raw.tipo ?? raw.type),
    serialNumber: strOrNull(raw.numeroSerie ?? raw.serialNumber ?? raw.sn),
    mac: strOrNull(raw.mac),
    patrimonialNo: strOrNull(raw.patrimonio ?? raw.patrimonialNo),
    modelDescription: strOrNull(raw.modelo ?? raw.modelDescription),
  };
}

export function parseResultCode(raw: Record<string, unknown>, soTypeId: string | null): IClassResultCodeDescriptor {
  return {
    soTypeId,
    code: String(raw.codigo ?? '').trim(),
    type: String(raw.tipo ?? '').trim(),
  };
}

// ── Ola A: OS Actions (getServiceOrder + closeServiceOrder) ────────────────────

/**
 * Date → "yyyy-MM-dd HH:mm:ss -0000" (IClass closeDate format for POST /serviceorders/close).
 *
 * FIX closeDate — el formato anterior ("dd/MM/yyyy HH:mm:ss", 2 tokens separados por
 * espacio) hacía que IClass respondiera HTTP 417 "Index 2 out of bounds for length 2":
 * su parser hace split por espacio y espera el offset de zona como TERCER token. El
 * formato correcto tiene 3 tokens: fecha, hora y offset. Emitimos en UTC con offset
 * fijo "-0000" para que los valores de pared (wall-clock) coincidan con el offset
 * declarado (de ahí los getters UTC, no los locales).
 */
export function formatCloseDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} -0000`
  );
}

/**
 * Date → "yyyy-MM-dd HH:mm:ss -0000" in ARGENTINA wall-clock for IClass schedule fields.
 *
 * IClass reads the HH:mm literally as its local time (Argentina, UTC-3). The prod
 * container runs in UTC, so we MUST convert to Argentina wall-clock before formatting.
 * The offset token stays "-0000" (IClass ignores it; only the HH:mm matters).
 * Uses Intl.DateTimeFormat with timeZone 'America/Argentina/Buenos_Aires' to handle
 * DST correctly (Argentina observes no DST but this is the correct IANA key).
 */
export function formatScheduleDate(d: Date): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  // en-CA gives "yyyy-MM-dd, HH:mm:ss" — we need "yyyy-MM-dd HH:mm:ss -0000"
  const parts = fmt.formatToParts(d);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '00';
  const yyyy = get('year');
  const MM = get('month');
  const dd = get('day');
  const hh = get('hour');
  const mi = get('minute');
  const ss = get('second');
  return `${yyyy}-${MM}-${dd} ${hh}:${mi}:${ss} -0000`;
}
