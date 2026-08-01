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
import type { TeamLocationPoint } from '@domain/entities/team-location-point';
import type { TeamDescriptor, TeamTrailPage } from '@domain/ports/TeamLocationSource';
import { parseIClassDateTime } from '@domain/services/iclassDateTime';

/** Default cluster — the only IPNEXT cluster in IClass. */
const DEFAULT_CLUSTER = 'IPNEXT INTERNET';
/** Backoff between sub-resource calls to dodge the "Espere um pouco" rate limit. */
const SUBRESOURCE_BACKOFF_MS = 400;
/** Window (days) scanned over recent SOs to discover active soType ids for the
 * result-code catalog sync. Under the IClass 30-day list cap. */
const RESULT_CODE_DISCOVERY_DAYS = 28;
/** Window (days) used by getServiceOrder to find the OS via the list endpoint.
 * IClass caps the updatedDate range at 30 days; we use 29 to stay safely under.
 * A Prominense-created OS that was last updated more than 29 days ago won't be
 * found by the pre-check — acceptable since assign/close act on recent OS. */
const SERVICE_ORDER_LOOKUP_DAYS = 29;
/** Máximo de reintentos ante un HTTP 429 (rate-limit de estado). */
const MAX_RATE_LIMIT_RETRIES = 4;
/**
 * Backstop de `fetchAllPages`: tope duro de páginas ante un endpoint cuyas páginas
 * nunca vienen cortas/vacías (bucle infinito contra IClass). 200 páginas × pagesize
 * 60-100 ≈ 12.000-20.000 items — muy por encima de cualquier ventana real medida
 * (416 OS en 26 días para /serviceorders; los sub-recursos son listas de UNA sola OS,
 * con como mucho unas pocas decenas de entradas). Si se alcanza, se corta Y SE
 * LOGUEA — un corte silencioso es exactamente el bug que este método existe para
 * evitar. Mismo valor que `LOCATIONS_MAX_PAGES`, por consistencia.
 */
const FETCH_ALL_PAGES_MAX_PAGES = 200;
/**
 * Páginas vacías consecutivas requeridas para dar por terminada la paginación en
 * estrategia 'empty-run' — mismo criterio ya probado en `listTeamLocations` para
 * /teams/{id}/locations (una página corta ahí NO implica que sea la última).
 */
const FETCH_ALL_PAGES_EMPTY_RUN_STOP = 2;

/** Estrategia de corte de `fetchAllPages`, elegida por el llamador según evidencia
 * medida del endpoint (ver JSDoc de `fetchAllPages`). */
type FetchAllPagesStrategy = 'strict' | 'empty-run';

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
    // strict: verified live — 3 consecutive FULL pages of 60 on /serviceorders,
    // then nothing more. No evidence of the /teams/{id}/locations anomaly here.
    const raw = await this.fetchAllPages(`/serviceorders`, base, { strategy: 'strict' });
    return raw.map(o => parseServiceOrderSummary(o, this.clusterName));
  }

  async getServiceOrderHistory(iclassId: string): Promise<SoStatusHistoryEntry[]> {
    // strict: bounded per-OS list on the same /serviceorders* list engine as
    // listServiceOrders (a handful of status transitions per OS) — no evidence
    // of the /teams/{id}/locations short-intermediate-page anomaly here.
    const raw = await this.fetchAllPages(
      `/serviceorders/${iclassId}/history`,
      new URLSearchParams({ pagesize: '60' }),
      { strategy: 'strict' },
    );
    return raw.map(parseHistoryEntry);
  }

  async getServiceOrderChecklists(iclassId: string): Promise<SoChecklist[]> {
    // strict — same reasoning as getServiceOrderHistory: bounded per-OS list.
    const raw = await this.fetchAllPages(
      `/serviceorders/${iclassId}/checklist`,
      new URLSearchParams({ pagesize: '60' }),
      { strategy: 'strict' },
    );
    return raw.map(parseChecklist);
  }

  async getServiceOrderMaterials(iclassId: string): Promise<SoMaterial[]> {
    // strict — same reasoning as getServiceOrderHistory: bounded per-OS list.
    const raw = await this.fetchAllPages(
      `/serviceorders/${iclassId}/materials`,
      new URLSearchParams({ pagesize: '60' }),
      { strategy: 'strict' },
    );
    return raw.map(parseMaterial);
  }

  async getServiceOrderEquipmentEvents(iclassId: string): Promise<SoEquipmentEvent[]> {
    // strict — same reasoning as getServiceOrderHistory: bounded per-OS list.
    const raw = await this.fetchAllPages(
      `/serviceorders/${iclassId}/equipments/history`,
      new URLSearchParams({ pagesize: '60' }),
      { strategy: 'strict' },
    );
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
    // strict — same endpoint/evidence as listServiceOrders (/serviceorders).
    const sos = await this.fetchAllPages(
      '/serviceorders',
      new URLSearchParams({
        clusterName: this.clusterName,
        updatedDate_begin: formatListDate(begin),
        updatedDate_end: formatListDate(now),
        pagesize: '60',
      }),
      { strategy: 'strict' },
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
      // strict — bounded catalog per soType (a handful of result codes), same
      // family of endpoint as the other /serviceorders* list resources; no
      // evidence of the /teams/{id}/locations anomaly here.
      const codes = await this.fetchAllPages(
        `/serviceordertypes/${id}/resultcodes`,
        new URLSearchParams({ pagesize: '100' }),
        { strategy: 'strict' },
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
   * GET a paginated IClass list resource.
   *
   * IClass does NOT reliably expose pagination metadata: `hasMoreElements` is
   * omitted regardless of `pagesize` (verified live against /serviceorders with
   * pagesize=60 AND pagesize=1 — never present; only `currentpage`/`pagesize`/
   * `offset` come back), and `totalpages`/`totalobjects` are equally unreliable.
   * Trusting `hasMoreElements` broke this exact method: `!undefined === true`
   * made it `break` after page 1 on EVERY call, silently, in production (see
   * BACKLOG.md — SyncIClassStatuses saw ~13% of the OS in its 28-day window).
   *
   * Two cut strategies, picked per endpoint by the caller via `opts.strategy`:
   *  - 'strict' (default): stop as soon as a page comes back with fewer items
   *    than `pagesize` (or empty/204). Only safe where a short page reliably
   *    means "this was the last page" — verified live for /serviceorders (3
   *    consecutive FULL pages of 60, then nothing more). Every current call
   *    site uses this; none has evidence of the anomaly below.
   *  - 'empty-run': keep paginating through short-but-nonzero pages, stopping
   *    only after FETCH_ALL_PAGES_EMPTY_RUN_STOP pages come back with ZERO
   *    items in a row. Required for /teams/{id}/locations, where a live
   *    measurement caught an intermediate page with FEWER than pagesize items
   *    that was NOT the last page — cutting there lost 3.686 of 6.286 GPS
   *    points (59%), in silence. That endpoint paginates on its own
   *    (`listTeamLocations`, below) rather than through this method, but the
   *    strategy lives here too so a future caller that hits the same anomaly
   *    doesn't have to reinvent it.
   *
   * Guards that apply to BOTH strategies:
   *  - Hard cap at FETCH_ALL_PAGES_MAX_PAGES — backstop against an endpoint
   *    whose pages never come back short/empty, which would otherwise loop
   *    forever against IClass. Logs a warning when hit: a silent truncation
   *    here is exactly the bug this method exists to prevent.
   *  - 204 / empty body ends pagination (unchanged from before this fix).
   *  - The textual "Espere um pouco" rate-limit is retried once with backoff;
   *    if it persists, throws IClassUnavailableError — a persistent rate-limit
   *    must never be silently treated as an empty list (that would cause
   *    getServiceOrder to return null, which callers interpret as "OS not
   *    found" — a silent corruption). Unchanged from before this fix.
   */
  private async fetchAllPages(
    path: string,
    params: URLSearchParams,
    opts: { strategy?: FetchAllPagesStrategy } = {},
  ): Promise<Record<string, unknown>[]> {
    const strategy = opts.strategy ?? 'strict';
    const pageSizeRaw = params.get('pagesize');
    const pageSize = pageSizeRaw !== null ? parseInt(pageSizeRaw, 10) : NaN;
    if (strategy === 'strict' && !Number.isFinite(pageSize)) {
      // Programmer error: strict mode needs a numeric pagesize to tell a full
      // page from an incomplete one. Every current call site sets it.
      throw new Error(`fetchAllPages: strict strategy requires a numeric 'pagesize' param (got ${pageSizeRaw})`);
    }

    const out: Record<string, unknown>[] = [];
    let page = 1;
    let consecutiveEmpty = 0;
    let cappedOut = true; // flipped to false by any natural exit below

    while (page <= FETCH_ALL_PAGES_MAX_PAGES) {
      params.set('pagenumber', String(page));
      let data = await this.authedGet<unknown>(`${path}?${params.toString()}`);
      if (isRateLimited(data)) {
        await this.sleep(this.subresourceBackoffMs * 2);
        data = await this.authedGet<unknown>(`${path}?${params.toString()}`);
        // If still rate-limited after the retry, throw — must not return empty list.
        if (isRateLimited(data)) {
          throw new IClassUnavailableError('IClass rate-limited (Espere um pouco) on list');
        }
      }
      if (!data || typeof data !== 'object') {
        cappedOut = false;
        break; // 204 / empty body — end of pagination
      }
      const body = data as { objects?: unknown[] };
      const objects = Array.isArray(body.objects) ? body.objects : [];
      for (const o of objects) if (o && typeof o === 'object') out.push(o as Record<string, unknown>);

      if (strategy === 'empty-run') {
        if (objects.length === 0) {
          consecutiveEmpty++;
          if (consecutiveEmpty >= FETCH_ALL_PAGES_EMPTY_RUN_STOP) {
            cappedOut = false;
            break;
          }
        } else {
          consecutiveEmpty = 0;
        }
      } else {
        // strict: a page shorter than pagesize (including empty) is the last one.
        if (objects.length < pageSize) {
          cappedOut = false;
          break;
        }
      }
      page++;
    }

    if (cappedOut) {
      console.warn(
        `[iclass] fetchAllPages: tope de ${FETCH_ALL_PAGES_MAX_PAGES} páginas alcanzado en ${path} — puede haber datos sin leer`,
        { path, strategy, itemsCollected: out.length },
      );
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
   * Fetch the current state of a Service Order by its CODE (e.g. "4949") for
   * the live pre-check before assign/close actions.
   *
   * WHY via list: callers pass `task.iclassOrderCode` (the OS code returned by
   * createServiceOrder as `codigoOS`). The endpoint `GET /serviceorders/{id}`
   * expects IClass's INTERNAL numeric id — passing the code returns HTTP 204
   * (no OS with that internal id). The list endpoint accepts a `serviceOrderCode`
   * filter and returns the full summary shape, so we resolve the OS via the list
   * and return the first exact-code match.
   *
   * Lookback window: IClass caps the updatedDate range at 30 days; we use 29
   * (SERVICE_ORDER_LOOKUP_DAYS). An OS last updated more than 29 days ago won't
   * be found — acceptable since assign/close act on recently-created OS.
   *
   * Exact-match guard: the IClass filter may behave as a LIKE/prefix match, so
   * we require `String(m.iclassCodigo) === String(code)` — not just matches[0].
   *
   * Rate-limit safety: fetchAllPages throws IClassUnavailableError when a
   * rate-limit ("Espere um pouco") persists after one retry, so a rate-limit is
   * never silently returned as an empty list (which getServiceOrder would map to
   * null = "OS not found"). A true HTTP 429 also propagates as IClassUnavailableError.
   */
  async getServiceOrder(code: string): Promise<ServiceOrderSnapshot | null> {
    const now = this.now();
    const begin = new Date(now.getTime() - SERVICE_ORDER_LOOKUP_DAYS * 24 * 60 * 60 * 1000);
    const matches = await this.listServiceOrders({
      serviceOrderCode: code,
      updatedDateBegin: begin,
      updatedDateEnd: now,
    });
    const m = matches.find(s => String(s.iclassCodigo) === String(code)) ?? null;
    if (!m) return null;
    return {
      iclassId: m.iclassId,
      iclassCodigo: m.iclassCodigo,
      statusCode: m.statusCode,
      statusDescription: m.statusDescription,
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

  // ── Rastro GPS de cuadrillas (change iclass-gps-audit) ────────────────────
  //
  // OJO — estos métodos NO usan `fetchAllPages`, aunque ahora esa función SÍ
  // soporta la estrategia 'empty-run' que necesitan (fix del bug de paginación
  // del BACKLOG: `fetchAllPages` confiaba en `hasMoreElements`, que IClass no
  // devuelve, y cortaba en la página 1 SIEMPRE). Se mantienen con su loop
  // propio — ya escrito, medido y testeado contra la anomalía específica de
  // /teams/{id}/locations (página corta intermedia que NO era la última) —
  // en vez de migrarlos para no tocar código en producción sin necesidad.

  /** Tamaño de página del rastro. */
  private static readonly LOCATIONS_PAGE_SIZE = 100;
  /** Páginas vacías consecutivas necesarias para dar el rastro por terminado. */
  private static readonly LOCATIONS_EMPTY_PAGES_TO_STOP = 2;
  /** Tope duro de páginas — backstop ante un paginado que nunca se vacíe. */
  private static readonly LOCATIONS_MAX_PAGES = 200;
  /** Solapamiento del watermark: cubre breadcrumbs bufferados offline (hallazgo 2.7). */
  private static readonly LOCATIONS_WATERMARK_OVERLAP_MS = 2 * 60 * 60 * 1000;
  /** Tolerancia de reloj hacia el futuro antes de descartar un punto (hallazgo 2.8). */
  private static readonly LOCATIONS_FUTURE_TOLERANCE_MS = 60 * 60 * 1000;

  /**
   * Catálogo de cuadrillas con su id interno de IClass resuelto.
   *
   * Existe aparte de `listTeams()` porque necesita un dato que aquel no expone: el id
   * numérico, que IClass **no devuelve** en el campo `id` (llega `null`) y sólo aparece
   * embebido en las URLs de sub-recursos (`localizacoes: "/teams/{id}/locations"`).
   */
  async listTeamLocationDescriptors(): Promise<TeamDescriptor[]> {
    const data = await this.authedGet<unknown>(
      `/teams?thirdPartyId=${this.thirdPartyId}&pagesize=200`,
    );
    // Un rate limit acá devolvía un ROSTER VACÍO en silencio: el ingest no procesaba
    // ninguna cuadrilla y el mapa mostraba cero, todo reportado como éxito (hallazgo 2.1).
    if (isRateLimited(data)) {
      throw new IClassUnavailableError('IClass rate-limited al listar cuadrillas');
    }
    const body = (data ?? {}) as {
      objects?: Array<{
        login?: unknown;
        nome?: unknown;
        name?: unknown;
        status?: unknown;
        localizacoes?: unknown;
      }>;
    };

    const out: TeamDescriptor[] = [];
    for (const o of body.objects ?? []) {
      const login = String(o.login ?? '').trim();
      if (!login) continue;
      const externalId = parseTeamIdFromLocationsUrl(o.localizacoes);
      if (!externalId) continue; // sin id no hay rastro que pedir
      out.push({
        login,
        name: String(o.nome ?? o.name ?? '').trim(),
        externalId,
        status: o.status != null ? String(o.status).trim() : null,
      });
    }
    return out;
  }

  /**
   * Rastro completo de una cuadrilla, con paginación ROBUSTA.
   *
   * Reglas (delta REQ-ICLASS-LOC-2, verificadas contra la API real):
   *  - NO cortar ante una página con menos ítems que el pagesize. Medido: cortar ahí
   *    trajo 2.600 de 6.286 puntos — 59% perdido, en silencio.
   *  - Cortar sólo tras DOS páginas vacías o 204 consecutivas.
   *  - No mirar hasMoreElements/totalpages/totalobjects: IClass los omite.
   *
   * @param stopAtOrBefore watermark: el rastro viene DESCENDENTE, así que al alcanzar
   *        un punto que ya se tiene persistido se deja de paginar.
   */
  async listTeamLocations(
    externalId: string,
    teamLogin: string,
    stopAtOrBefore?: Date | null,
    now: Date = new Date(),
  ): Promise<TeamTrailPage> {
    const points: TeamLocationPoint[] = [];
    // SOLAPAMIENTO (hallazgo 2.7): un celular sin señal bufferea fixes y los sube al
    // reconectar, con timestamps ANTERIORES al watermark. Sin solapamiento se descartan
    // para siempre — justo el caso que la auditoría más necesita resolver. La dedup por
    // unique de la base absorbe lo que se relee, así que releer es gratis.
    const watermarkMs = stopAtOrBefore
      ? stopAtOrBefore.getTime() - IClassClient.LOCATIONS_WATERMARK_OVERLAP_MS
      : null;
    // Cota superior de cordura: un reloj adelantado en el dispositivo (o un dato corrupto)
    // insertaría un punto en el futuro que se volvería el watermark y bloquearía el ingest
    // por años, en silencio (hallazgo 2.8).
    const maxAcceptableMs = now.getTime() + IClassClient.LOCATIONS_FUTURE_TOLERANCE_MS;

    let page = 1;
    let pagesRead = 0;
    let consecutiveEmpty = 0;
    let pointsDropped = 0;

    while (page <= IClassClient.LOCATIONS_MAX_PAGES) {
      let data: unknown;
      try {
        data = await this.authedGet<unknown>(
          `/teams/${externalId}/locations?pagesize=${IClassClient.LOCATIONS_PAGE_SIZE}&pagenumber=${page}`,
        );
      } catch {
        // Rate-limit persistente o error de transporte: se devuelve lo leído hasta acá
        // marcado como INCOMPLETO. Nunca reportar éxito con datos parciales.
        return { points, pagesRead, incomplete: true, pointsDropped };
      }
      pagesRead++;

      // EL RATE LIMIT DE ICLASS LLEGA COMO HTTP 200 CON TEXTO PLANO (hallazgo 2.1).
      // Tratarlo como página vacía cortaba el rastro con incomplete:false. Este es el
      // único método del cliente que no lo chequeaba; los otros cuatro sí.
      if (isRateLimited(data)) {
        return { points, pagesRead, incomplete: true, pointsDropped };
      }

      // 204 / cuerpo vacío → no es objeto.
      const objects =
        data && typeof data === 'object' && Array.isArray((data as { objects?: unknown[] }).objects)
          ? ((data as { objects: unknown[] }).objects as unknown[])
          : [];

      if (objects.length === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= IClassClient.LOCATIONS_EMPTY_PAGES_TO_STOP) {
          return { points, pagesRead, incomplete: false, pointsDropped };
        }
        page++;
        continue;
      }
      consecutiveEmpty = 0;

      let reachedWatermark = false;
      let parsedInPage = 0;
      for (const raw of objects) {
        const point = parseTeamLocationPoint(raw, teamLogin);
        if (!point) {
          // ILEGIBLE: el contrato de la API cambió. Alimenta el detector de página muerta.
          pointsDropped++;
          continue;
        }
        // R9 de la re-review: un punto FUTURO sí se pudo PARSEAR — se descarta por
        // política, no por ilegibilidad. Contarlo como no-parseado hacía que un
        // dispositivo con el reloj adelantado (cuyos puntos van PRIMERO, porque el rastro
        // es descendente) llenara la página 1 y disparara `incomplete` para siempre: el
        // watermark contiguo no avanzaba nunca y la cuadrilla quedaba congelada
        // releyendo lo mismo hasta que IClass purgara el resto. El fix 2.8 habría
        // cambiado "envenenar el watermark 10 años" por "no ingestar nunca más".
        parsedInPage++;
        if (point.recordedAt.getTime() > maxAcceptableMs) {
          pointsDropped++;
          continue;
        }
        // ESTRICTO (hallazgo 2.6): con `<=` se perdía el segundo punto del mismo instante
        // con distinta coordenada, que el unique de la base considera una fila legítima.
        if (watermarkMs !== null && point.recordedAt.getTime() < watermarkMs) {
          reachedWatermark = true;
          continue;
        }
        points.push(point);
      }

      // Una página LLENA de la que no se pudo parsear NADA significa que el contrato
      // cambió. Seguir paginando en silencio produce "0 puntos, corrida exitosa".
      if (parsedInPage === 0) {
        return { points, pagesRead, incomplete: true, pointsDropped };
      }

      if (reachedWatermark) {
        return { points, pagesRead, incomplete: false, pointsDropped };
      }

      page++;
    }

    // Se agotó el tope de páginas sin llegar al final natural del rastro: hay más datos
    // que no se leyeron (hallazgo 2.3). El backstop contra el loop infinito no puede
    // hacerse pasar por una lectura completa.
    return { points, pagesRead, incomplete: true, pointsDropped };
  }

  /**
   * Última posición conocida de una cuadrilla.
   * `null` ante 204 — es la respuesta NORMAL para cuadrillas sin rastro (5 de los 11
   * logins de IPNEXT son cuentas canceladas o duplicadas). Tratarlo como error rompería
   * el ingest en cada corrida.
   */
  async getLastTeamLocation(login: string): Promise<TeamLocationPoint | null> {
    const data = await this.authedGet<unknown>(
      `/teams/lastlocation?login=${encodeURIComponent(login)}`,
    );
    if (!data || typeof data !== 'object') return null;
    return parseTeamLocationPoint(data, login);
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
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;

  const raw = String(v).trim();
  if (raw === '') return null;

  // COMA DECIMAL (re-review R5): IClass es lusófono y puede emitir "-34,70084".
  // `parseFloat` lo TRUNCA a -34 sin error y sin NaN — 78 km de desvío sobre el dato
  // que DECIDE el veredicto de presencia (addressLat/addressLng), y `Number.isFinite`
  // lo deja pasar. Se normaliza la coma antes de convertir, y se usa `Number` (no
  // `parseFloat`) para que "34abc" dé NaN en vez de 34.
  const normalized = raw.includes(',') && !raw.includes('.') ? raw.replace(',', '.') : raw;
  const n = Number(normalized);
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
 * Date → "yyyy-MM-dd HH:mm:ss -0300" in ARGENTINA wall-clock for IClass schedule fields.
 *
 * VERIFIED LIVE 2026-06-18: IClass INTERPRETS the offset token (it does NOT ignore it).
 * So the offset MUST match the wall-clock. We emit Argentina time (UTC-3) with offset
 * "-0300". Sending Argentina HH:mm tagged "-0000" makes IClass read it as UTC and shift
 * the appointment 3h earlier (observed: 13:00 became 10:00). The prod container runs in
 * UTC, so we convert the instant to Argentina wall-clock via Intl. Argentina observes no
 * DST, so -0300 is constant year-round.
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
  // -0300 (Argentina): IClass interprets the offset, so it MUST match the wall-clock.
  return `${yyyy}-${MM}-${dd} ${hh}:${mi}:${ss} -0300`;
}

// ── Parsers del rastro GPS de cuadrillas (change iclass-gps-audit) ───────────

/**
 * Extrae el id numérico de la cuadrilla del path embebido en `localizacoes`
 * (`/teams/{id}/locations`). IClass devuelve `id: null` en el listado de teams, así que
 * esta URL es la ÚNICA fuente del identificador.
 */
export function parseTeamIdFromLocationsUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = /\/teams\/(\d+)\//.exec(raw);
  return m ? m[1] : null;
}

/**
 * `TeamLocationDTO` de IClass → punto del dominio.
 *
 * Devuelve `null` si el timestamp o las coordenadas no son legibles: un punto ilegible
 * se descarta, nunca se emite con `Invalid Date` o `NaN` (eso se propaga silencioso y
 * explota lejos del origen).
 *
 * `raio` (precisión) y `origem` se conservan VERBATIM: sin la precisión no se puede
 * calificar honestamente un veredicto de presencia.
 */
export function parseTeamLocationPoint(raw: unknown, teamLogin: string): TeamLocationPoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  // OJO: `Number(null)` y `Number('')` dan 0, que ES finito y pasaría el guard, metiendo
  // un punto en el Golfo de Guinea como si fuera legítimo. Se exige que el valor crudo
  // sea number o string no vacío ANTES de convertir.
  const latitude = toFiniteNumber(o.latitude);
  const longitude = toFiniteNumber(o.longitude);
  if (latitude === null || longitude === null) return null;

  const recordedAt = parseIClassDateTime(
    typeof o.dataRegistro === 'string' ? o.dataRegistro : null,
  );
  if (!recordedAt) return null;

  const accuracy = toFiniteNumber(o.raio);
  const origem = toFiniteNumber(o.origem);

  return {
    teamLogin,
    latitude,
    longitude,
    recordedAt,
    // Precisión ausente o inválida ⇒ DESCONOCIDA (null), nunca 0: un 0 significaría
    // "GPS perfecto" y es la lectura más dura posible contra el técnico.
    accuracyMeters: accuracy !== null && accuracy >= 0 ? accuracy : null,
    sources: origem !== null ? [origem] : [],
  };
}

/** Convierte a número finito sólo desde `number` o `string` no vacía. `null` en cualquier otro caso. */
function toFiniteNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
