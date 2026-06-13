import axios, { AxiosInstance } from 'axios';
import type { GigaredConfigRepository } from '@domain/ports/GigaredConfigRepository';
import type {
  GigaredPort,
  GigaredAccount,
  GigaredSummary,
  GigaredOtt,
  GigaredOttStatus,
  GigaredService,
  GigaredPartnerService,
  ListAccountsFilter,
} from '@domain/ports/GigaredPort';
import {
  GigaredNotConfiguredError,
  GigaredUnavailableError,
  GigaredAuthError,
  GigaredNotFoundError,
  GigaredRejectedError,
} from '@domain/errors/gigared';

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 4;
const DEFAULT_BACKOFF_MS = 400;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Minimal shape of an axios-style transport error. */
function isAxiosLikeError(e: unknown): e is {
  response?: { status?: number; headers?: Record<string, unknown>; data?: unknown };
} {
  return typeof e === 'object' && e !== null && 'isAxiosError' in e;
}

/** Extract Retry-After (integer seconds) → ms. Non-numeric/date forms → undefined. */
function parseRetryAfterMs(e: unknown): number | undefined {
  if (!isAxiosLikeError(e)) return undefined;
  const raw = e.response?.headers?.['retry-after'];
  if (raw === null || raw === undefined) return undefined;
  const seconds = parseInt(String(raw), 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return seconds * 1000;
}

// ---- raw wire shapes (snake_case — confined to this file) -------------------
interface RawCrm {
  cic: string;
  gigared_id: string | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  registration_date: string | null;
  services: GigaredService[];
}
interface RawOtt {
  id: string;
  qty_stationary_licenses: number;
  qty_mobile_licenses: number;
  qty_registered_devices: number;
  status: string | null;
}
interface RawAccount {
  crm: RawCrm;
  internal_id: string | null;
  ott: RawOtt | null;
}
interface RawPartnerService {
  id: string;
  name: string;
  qty_available: number;
  qty_used: number;
  qty_purchased: number;
}
interface RawSummary {
  accounts: { registered: number; unregistered: number; total: number };
  services: RawPartnerService[];
}
/** Every Gigared response is `{ message, detail }`. */
interface Envelope<T> {
  message: string;
  detail: T;
}

/**
 * #2 — The partner sends registration_date as DD/MM/YYYY (e.g. "19/01/2026").
 * Normalize to ISO YYYY-MM-DD so callers (FE, DB) get a standard date string.
 * Null / empty / garbage → null. Already-ISO strings (YYYY-MM-DD) pass through.
 */
function normalizeRegistrationDate(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  // Already ISO (YYYY-MM-DD): /^\d{4}-\d{2}-\d{2}$/
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // DD/MM/YYYY
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

/**
 * #3 — Derive the bare Client.id from internalId by stripping the trailing -\d+ suffix.
 * The TV identity is {clientId}-{seq} (seq is a non-negative int, no hyphens). Bare UUIDs
 * (no suffix) are returned unchanged. Null → null.
 */
function deriveClientId(internalId: string | null): string | null {
  if (internalId === null) return null;
  return internalId.replace(/-\d+$/, '');
}

/**
 * #47j — the LIVE Gigared API sends ott.status as Spanish free-text
 * ("habilitado"/"deshabilitado", also null) — NOT the docs' 'active'. Normalize to the
 * frozen tri-state 'enabled'|'disabled'|null so the FE never parses raw upstream text.
 * Tolerant: lowercase + trim. Any other non-empty string → warn + null (defensive).
 */
function normalizeOttStatus(raw: string | null): GigaredOttStatus {
  if (raw === null || raw === undefined) return null;
  const v = String(raw).trim().toLowerCase();
  if (v === '') return null;
  if (v === 'habilitado') return 'enabled';
  if (v === 'deshabilitado') return 'disabled';
  console.warn('[gigared] unknown ott.status', raw);
  return null;
}

function mapOtt(o: RawOtt | null): GigaredOtt | null {
  if (!o) return null;
  return {
    id: o.id,
    stationaryLicenses: o.qty_stationary_licenses,
    mobileLicenses: o.qty_mobile_licenses,
    registeredDevices: o.qty_registered_devices,
    status: normalizeOttStatus(o.status),
  };
}

function mapAccount(raw: RawAccount): GigaredAccount {
  return {
    cic: raw.crm.cic,
    gigaredId: raw.crm.gigared_id,
    email: raw.crm.email,
    firstName: raw.crm.first_name,
    lastName: raw.crm.last_name,
    registrationDate: normalizeRegistrationDate(raw.crm.registration_date),
    services: raw.crm.services ?? [],
    internalId: raw.internal_id,
    clientId: deriveClientId(raw.internal_id),
    ott: mapOtt(raw.ott),
  };
}

function mapPartnerService(s: RawPartnerService): GigaredPartnerService {
  return {
    id: s.id,
    name: s.name,
    qtyAvailable: s.qty_available,
    qtyUsed: s.qty_used,
    qtyPurchased: s.qty_purchased,
  };
}

export interface GigaredClientOptions {
  configProvider: GigaredConfigRepository;
  timeoutMs?: number;
  /** Injectable HTTP client for deterministic tests. */
  http?: AxiosInstance;
  maxRateLimitRetries?: number;
  backoffMs?: number;
  /** Injectable sleep for tests (no real waits). */
  _sleep?: (ms: number) => Promise<void>;
}

/**
 * Adapter for the Gigared Partners API (#47).
 *
 * The apiKey + baseUrl are read from `configProvider` on EVERY call (D1) — a PUT to
 * /config takes effect immediately, multi-instance safe, zero invalidation bugs.
 * Axios has no fixed baseURL (baseUrl is config-driven): each request uses
 * `${cfg.baseUrl}${path}` + header `X-API-Key`. An empty key throws
 * GigaredNotConfiguredError BEFORE any network call. `withRetry429` mirrors
 * IClassClient.withAuthRetry MINUS the 401-relogin branch (Gigared has no login flow).
 * Raw axios / snake_case never crosses the layer boundary.
 */
export class GigaredClient implements GigaredPort {
  private readonly http: AxiosInstance;
  private readonly configProvider: GigaredConfigRepository;
  private readonly maxRateLimitRetries: number;
  private readonly backoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: GigaredClientOptions) {
    this.configProvider = opts.configProvider;
    this.maxRateLimitRetries = opts.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.sleep = opts._sleep ?? sleep;
    this.http = opts.http ?? axios.create({ timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  }

  // ---- per-call config + request helpers -----------------------------------

  private async requestConfig(): Promise<{ baseUrl: string; headers: Record<string, string> }> {
    const cfg = await this.configProvider.get();
    if (!cfg.apiKey) throw new GigaredNotConfiguredError();
    return { baseUrl: cfg.baseUrl, headers: { 'X-API-Key': cfg.apiKey } };
  }

  /** Retry 429 (Retry-After or exponential backoff), then map errors. No 401-relogin. */
  private async withRetry429<T>(fn: () => Promise<{ data: T }>): Promise<T> {
    for (let attempt = 0; attempt <= this.maxRateLimitRetries; attempt++) {
      try {
        const res = await fn();
        return res.data;
      } catch (e) {
        if (isAxiosLikeError(e) && e.response?.status === 429 && attempt < this.maxRateLimitRetries) {
          const ms = parseRetryAfterMs(e) ?? this.backoffMs * Math.pow(2, attempt);
          await this.sleep(ms);
          continue;
        }
        throw this.mapError(e);
      }
    }
    throw this.mapError(new Error('withRetry429: loop exhausted unexpectedly'));
  }

  /**
   * Translate transport errors to domain errors. Never leak axios cross-layer.
   *
   * #47d — the LIVE Gigared API (verified 2026-06-11) DIFFERS from its docs. It speaks
   * RFC 9457: every 4xx carries a `type` URI. We discriminate on `type` (NOT free-text):
   *   - .../external-service-error (424) + detail "no se encontró" → NOT_FOUND (the CUA's
   *     "this account/internal_id does not exist"). Any OTHER 424 → UNAVAILABLE (CUA down).
   *   - .../cic-ownership-error (403) → NOT_FOUND ("the reseller does not own this CIC" ≡
   *     inexistent for us; maps to CIC_NOT_FOUND in the link, not-found in lookups).
   *   - .../invalid-api-key (403/401), or any 401/403 WITHOUT a recognized type → AUTH.
   */
  private mapError(e: unknown): Error {
    if (
      e instanceof GigaredNotConfiguredError ||
      e instanceof GigaredUnavailableError ||
      e instanceof GigaredAuthError ||
      e instanceof GigaredNotFoundError ||
      e instanceof GigaredRejectedError
    ) {
      return e;
    }
    if (isAxiosLikeError(e)) {
      const status = e.response?.status;
      const body = e.response?.data as { type?: string; title?: string; detail?: string } | undefined;
      const type = body?.type ?? '';
      const detail = body?.detail;

      // RFC 9457 type-based discrimination (#47d) — takes precedence over bare status.
      // cic-ownership (403): for our partner, "not owned" ≡ "not found".
      if (type.endsWith('/cic-ownership-error')) return new GigaredNotFoundError();
      // external-service-error (424): the CUA's "no se encontró ..." is a real not-found;
      // any other 424 is the CUA genuinely failing → outage.
      if (type.endsWith('/external-service-error')) {
        if (/no se encontr/i.test(detail ?? '')) return new GigaredNotFoundError();
        // #47g — every non-NotFound error is diagnostic noise worth seeing in prod logs.
        console.warn('[gigared] upstream', status, type, detail);
        return new GigaredUnavailableError('Gigared external service (CUA) error', detail);
      }

      // #47g — empty-accounts_list (404): a FILTERED listing that matched nothing. It is a
      // ZERO-ROW result, not a failure — return a NotFound TAGGED so ONLY listAccounts reads it
      // as []. Any other caller (single lookup) still sees a plain not-found. No warn (expected).
      if (status === 404 && type.endsWith('/empty-accounts_list')) {
        const nf = new GigaredNotFoundError() as GigaredNotFoundError & { _emptyList?: boolean };
        nf._emptyList = true;
        return nf;
      }

      // #47g — from here every branch is a non-NotFound failure → log it for prod diagnosis.
      if (status !== 404) console.warn('[gigared] upstream', status, type, detail);

      if (status === 401 || status === 403) return new GigaredAuthError('Gigared API key is invalid', detail);
      if (status === 404) return new GigaredNotFoundError();
      // 429 reaching mapError means retries were exhausted → treat as an outage, not a rejection.
      if (status === 429) return new GigaredUnavailableError('Gigared rate limit exceeded', detail);
      if (status !== undefined && status >= 400 && status < 500) {
        return new GigaredRejectedError(body?.title ?? 'Gigared rejected the request', detail ?? '');
      }
      return new GigaredUnavailableError(
        status ? `Gigared responded with HTTP ${status}` : 'Gigared connection failed',
        detail,
      );
    }
    return new GigaredUnavailableError();
  }

  private async get<T>(path: string): Promise<T> {
    const { baseUrl, headers } = await this.requestConfig();
    return this.withRetry429<T>(() => this.http.get(`${baseUrl}${path}`, { headers }));
  }
  private async post<T>(path: string, body?: unknown): Promise<T> {
    const { baseUrl, headers } = await this.requestConfig();
    return this.withRetry429<T>(() => this.http.post(`${baseUrl}${path}`, body ?? {}, { headers }));
  }
  private async patch<T>(path: string, body?: unknown): Promise<T> {
    const { baseUrl, headers } = await this.requestConfig();
    return this.withRetry429<T>(() => this.http.patch(`${baseUrl}${path}`, body ?? {}, { headers }));
  }
  private async put<T>(path: string): Promise<T> {
    const { baseUrl, headers } = await this.requestConfig();
    return this.withRetry429<T>(() => this.http.put(`${baseUrl}${path}`, {}, { headers }));
  }
  private async del<T>(path: string): Promise<T> {
    const { baseUrl, headers } = await this.requestConfig();
    return this.withRetry429<T>(() => this.http.delete(`${baseUrl}${path}`, { headers }));
  }

  // ---- port methods --------------------------------------------------------

  async getSummary(): Promise<GigaredSummary> {
    const env = await this.get<Envelope<RawSummary>>('/partners/summary');
    return {
      accounts: env.detail.accounts,
      services: env.detail.services.map(mapPartnerService),
    };
  }

  async listAccounts(filter?: ListAccountsFilter): Promise<GigaredAccount[]> {
    const qs = new URLSearchParams();
    if (filter?.accountId) qs.set('account_id', filter.accountId);
    if (filter?.useInternalId) qs.set('use_internal_id', 'true');
    if (filter?.email) qs.set('email', filter.email);
    if (filter?.status) qs.set('status', filter.status);
    if (filter?.paginationLimit !== undefined) qs.set('pagination_limit', String(filter.paginationLimit));
    if (filter?.paginationOffset !== undefined) qs.set('pagination_offset', String(filter.paginationOffset));
    const query = qs.toString();
    const path = `/accounts${query ? `?${query}` : ''}`;
    const { baseUrl, headers } = await this.requestConfig();
    try {
      const env = await this.withRetry429<Envelope<RawAccount[]>>(() => this.http.get(`${baseUrl}${path}`, { headers }));
      return env.detail.map(mapAccount);
    } catch (e) {
      // #47g — a filtered listing with no matches is HTTP 404 RFC 9457 `empty-accounts_list`
      // upstream. That is a ZERO-ROW result, NOT a failure. mapError turned it into a generic
      // GigaredNotFoundError (404 with no recognized type); we re-detect the precise type from
      // the original NotFound to return [] ONLY here (list semantics), never in single lookups.
      if (e instanceof GigaredNotFoundError && (e as { _emptyList?: boolean })._emptyList) return [];
      throw e;
    }
  }

  async getAccountByInternalId(internalId: string): Promise<GigaredAccount> {
    const env = await this.get<Envelope<RawAccount>>(
      `/accounts/${encodeURIComponent(internalId)}?use_internal_id=true`,
    );
    return mapAccount(env.detail);
  }

  /** C2 — lookup by CIC (no use_internal_id). 404 → GigaredNotFoundError (mapped to CIC_NOT_FOUND upstream). */
  async getAccountByCic(cic: string): Promise<GigaredAccount> {
    const env = await this.get<Envelope<RawAccount>>(`/accounts/${encodeURIComponent(cic)}`);
    return mapAccount(env.detail);
  }

  async register(input: {
    firstName: string;
    lastName: string;
    email: string;
    cic: string;
    password: string;
    sendActivationEmail: boolean;
  }): Promise<void> {
    await this.post('/accounts/register', {
      first_name: input.firstName,
      last_name: input.lastName,
      email: input.email,
      cic: input.cic,
      password: input.password,
      send_activation_email: input.sendActivationEmail,
    });
  }

  async activate(input: { cic: string; email: string }): Promise<void> {
    await this.post('/accounts/activate', { cic: input.cic, email: input.email });
  }

  async changePassword(cic: string, password: string): Promise<void> {
    // #65 — PATCH /accounts/{cic} { password }. Documented in tv.md; reuses the same
    // RFC 9457 error mapping as every other call (a rejection surfaces detail upstream).
    await this.patch(`/accounts/${encodeURIComponent(cic)}`, { password });
  }

  async setInternalId(cic: string, internalId: string): Promise<void> {
    await this.patch(`/accounts/${encodeURIComponent(cic)}/internal_id`, { internal_id: internalId });
  }

  async addService(internalId: string, serviceId: string): Promise<void> {
    await this.post(
      `/services/${encodeURIComponent(internalId)}?service_id=${encodeURIComponent(serviceId)}&use_internal_id=true`,
    );
  }

  async removeService(internalId: string, serviceId: string): Promise<void> {
    await this.del(
      `/services/${encodeURIComponent(internalId)}/${encodeURIComponent(serviceId)}?use_internal_id=true`,
    );
  }

  async renewCic(internalId: string): Promise<{ oldCic: string; newCic: string }> {
    // #64 — renueva el CIC por internal_id. Devuelve {old_cic,new_cic}; el partner reasigna
    // el internal_id al nuevo CIC. CancelTv lo limpia después con setInternalId(newCic, '').
    const env = await this.put<Envelope<{ old_cic: string; new_cic: string }>>(
      `/accounts/${encodeURIComponent(internalId)}/renew?use_internal_id=true`,
    );
    return { oldCic: env.detail.old_cic, newCic: env.detail.new_cic };
  }

  async setOtt(internalId: string, enabled: boolean): Promise<void> {
    const action = enabled ? 'enable' : 'disable';
    try {
      await this.put(`/ott/${encodeURIComponent(internalId)}/${action}?use_internal_id=true`);
    } catch (e) {
      // #47j — idempotent toggle: if the partner rejects because the account is ALREADY in
      // the desired state ("ya se encuentra (des)?habilitada"), that IS success — the FE's
      // desired state already holds. Any other rejection still propagates.
      // #1 — the partner may send this as a 409/GigaredRejectedError (documented) OR as a
      // 424 external-service-error/GigaredUnavailableError (observed live). Broaden the guard
      // to catch both: swallow whenever the idempotency phrase appears in the detail.
      if (e instanceof GigaredRejectedError && /ya se encuentra (des)?habilitada/i.test(e.detail)) {
        return;
      }
      if (e instanceof GigaredUnavailableError && /ya se encuentra (des)?habilitada/i.test(e.detail ?? '')) {
        return;
      }
      throw e;
    }
  }
}
