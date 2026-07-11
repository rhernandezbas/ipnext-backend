import axios, { AxiosInstance, AxiosResponse } from 'axios';
import crypto from 'crypto';
import he from 'he';
import {
  GestionRealPort,
  FetchClientsParams,
  FetchClientsResult,
  FetchContractsDeltaParams,
  FetchContractsDeltaResult,
  GetServiceOrdersParams,
} from '@domain/ports/GestionRealPort';
import {
  GrClient,
  GrClientBalance,
  GrContract,
  GrInvoice,
  GrServiceOrder,
} from '@domain/entities/gestionReal';

export interface GestionRealClientOptions {
  baseUrl: string;
  cuit: string;
  secret: string;
  /** Injectable clock for deterministic password tests. */
  now?: () => Date;
  timeoutMs?: number;
  /**
   * Resilience against GR's flaky load balancer (some nodes 503, others ok).
   * Retries transient failures (5xx / network / timeout / 429) with exponential
   * backoff. All defaults match the "Estándar" profile. GR calls are read-only
   * POSTs (idempotent) so retrying is safe.
   */
  /** Retries AFTER the initial attempt (⇒ maxRetries+1 attempts). Default 3. */
  maxRetries?: number;
  /** Base for the exponential backoff (ms): base·3^i + jitter. Default 300. */
  retryBaseMs?: number;
  /**
   * Upper cap for ANY single backoff wait (ms). Bounds a hostile/misconfigured
   * `Retry-After` (e.g. 3600s) so a 429 can't freeze the sync — and its distributed
   * `gr-sync` lock — for hours across all replicas. Default 30000 (30s).
   */
  maxBackoffMs?: number;
  /** Injectable delay — tests pass a no-op spy. Default setTimeout-based. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source — tests pin it. Default Math.random. */
  random?: () => number;
}

/**
 * Adapter for the Gestión Real external API.
 *
 * Auth is Basic with username = CUIT and a password that rotates daily:
 * MD5(CUIT + SECRET + "YYYY-MM-DD"). Every method is a POST to the root with an
 * `action` field. Responses are normalized by the pure helpers below.
 */
export class GestionRealClient implements GestionRealPort {
  private readonly http: AxiosInstance;
  private readonly cuit: string;
  private readonly secret: string;
  private readonly now: () => Date;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly maxBackoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(opts: GestionRealClientOptions) {
    this.cuit = opts.cuit;
    this.secret = opts.secret;
    this.now = opts.now ?? (() => new Date());
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryBaseMs = opts.retryBaseMs ?? 300;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30000;
    this.sleep =
      opts.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          const timer = setTimeout(resolve, ms);
          // Don't keep the event loop alive on a pending backoff (clean SIGTERM/deploy).
          (timer as { unref?: () => void }).unref?.();
        }));
    this.random = opts.random ?? Math.random;
    this.http = axios.create({
      baseURL: opts.baseUrl,
      timeout: opts.timeoutMs ?? 30000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * POST to GR with retry-on-transient + exponential backoff. All public methods
   * go through this so the retry is inherited uniformly. Auth (the daily MD5
   * password) is recomputed PER attempt in case a retry crosses the AR midnight.
   *
   * Retries only transient AxiosErrors (5xx / network-timeout / 429); 4xx auth
   * (401/403) and 400 fail fast (retrying won't fix a bad password or payload),
   * and any non-axios throw (e.g. a parser bug) propagates untouched. On exhausted
   * retries the last error is re-thrown so the caller still records `error: ...`
   * in SyncState — the badge stays honest about a REAL outage.
   */
  private async postWithRetry(payload: Record<string, unknown>): Promise<AxiosResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.http.post('', payload, { auth: this.auth() });
      } catch (err) {
        if (attempt >= this.maxRetries || !isRetryableAxiosError(err)) throw err;
        await this.sleep(this.backoffMs(attempt, err));
      }
    }
  }

  /**
   * Exponential backoff base·3^i + jitter[0,base); for 429 honors Retry-After.
   * The result is clamped to `maxBackoffMs` so a hostile/misconfigured Retry-After
   * can't block the run (and the gr-sync lock) for hours, and guarded against a
   * non-finite injected `random`.
   */
  private backoffMs(attempt: number, err: unknown): number {
    const exp = this.retryBaseMs * Math.pow(3, attempt);
    const jitter = Math.floor(this.random() * this.retryBaseMs);
    const raw = Math.max(exp + jitter, retryAfterMs(err) ?? 0);
    const bounded = Number.isFinite(raw) ? raw : exp;
    return Math.min(bounded, this.maxBackoffMs);
  }

  private auth() {
    const fecha = isoDate(this.now());
    const password = crypto.createHash('md5').update(`${this.cuit}${this.secret}${fecha}`).digest('hex');
    return { username: this.cuit, password };
  }

  async fetchClients(params: FetchClientsParams): Promise<FetchClientsResult> {
    const payload: Record<string, unknown> = {
      action: 'clientes_consulta',
      cantidad: params.cantidad,
      offset: params.offset,
    };
    if (params.fechaTipo) payload.fecha_tipo = params.fechaTipo;
    if (params.fechaDesde) payload.fecha_desde = params.fechaDesde;
    if (params.fechaHasta) payload.fecha_hasta = params.fechaHasta;
    if (params.estado) payload.estado = params.estado;

    const { data } = await this.postWithRetry(payload);
    return parseClientsResponse(data);
  }

  async fetchContractsByClient(grClienteId: string): Promise<GrContract[]> {
    const { data } = await this.postWithRetry({
      action: 'contrato',
      cli_id: Number(grClienteId),
      incluye_bajas: 'S',
    });
    return parseContractsResponse(data, grClienteId);
  }

  async fetchClientBalance(grClienteId: string): Promise<GrClientBalance> {
    const { data } = await this.postWithRetry({ action: 'cliente', cliente_id: Number(grClienteId) });
    return parseClientBalanceResponse(grClienteId, data);
  }

  /**
   * Fetch service orders via the GR `ordenesdeservicio` action.
   *
   * Sends `estado` (default 'PEND'), `fecha_tipo` (default 'c') and the
   * `fecha_desde`/`fecha_hasta` window (DD-MM-AAAA). The response is an object
   * keyed by order id; `parseServiceOrdersResponse` flattens it into an array.
   */
  async fetchContractsModifiedSince(p: FetchContractsDeltaParams): Promise<FetchContractsDeltaResult> {
    const { data } = await this.postWithRetry({
      action: 'contratos',
      fecha_tipo: p.fechaTipo ?? 'm',
      fecha_desde: p.fechaDesde,
      fecha_hasta: p.fechaHasta,
      cantidad: p.cantidad,
      offset: p.offset,
    });
    return parseContractsDeltaResponse(data);
  }

  async getServiceOrders(params: GetServiceOrdersParams): Promise<GrServiceOrder[]> {
    const payload: Record<string, unknown> = {
      action: 'ordenesdeservicio',
      estado: params.estado ?? 'PEND',
      fecha_tipo: params.fechaTipo ?? 'c',
    };
    if (params.fechaDesde) payload.fecha_desde = params.fechaDesde;
    if (params.fechaHasta) payload.fecha_hasta = params.fechaHasta;

    const { data } = await this.postWithRetry(payload);
    return parseServiceOrdersResponse(data);
  }
}

/**
 * HTTP statuses worth retrying: the transient 5xx that a flapping load balancer
 * emits, plus 429. Deliberately NOT the whole 5xx range — 501/505/511 are
 * permanent, so retrying them just burns attempts + backoff before failing anyway.
 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Only transient AxiosErrors are retryable. Any non-axios throw (e.g. a parser
 * bug) returns false so it propagates untouched — we never retry a code bug.
 * 4xx auth (401/403) and 400 are NOT retried (a retry won't fix a bad daily
 * password or a malformed payload). An axios error WITHOUT a response is a
 * network/timeout failure (ECONNRESET/ECONNABORTED/…) → retryable.
 */
function isRetryableAxiosError(err: unknown): boolean {
  const e = err as { isAxiosError?: boolean; response?: { status?: number } } | null;
  if (!e || e.isAxiosError !== true) return false;
  const status = e.response?.status;
  if (status === undefined) return true; // network / timeout
  return RETRYABLE_STATUS.has(status);
}

/**
 * Retry-After (in ms) for a 429 response, or null. Only the delta-seconds form is
 * honored (what GR sends); an HTTP-date or missing header falls back to null so
 * the caller uses the computed exponential backoff.
 */
function retryAfterMs(err: unknown): number | null {
  const e = err as { response?: { status?: number; headers?: Record<string, unknown> } } | null;
  if (!e || e.response?.status !== 429) return null;
  const headers = e.response.headers ?? {};
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  if (raw === undefined || raw === null) return null;
  const secs = parseInt(String(raw), 10);
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : null;
}

/**
 * Date → "YYYY-MM-DD" for the GR daily password, in Argentina time (UTC-3).
 *
 * GR validates MD5(CUIT+SECRET+fecha) against the Buenos Aires calendar date.
 * The prod container runs in UTC, so deriving the date from the process TZ
 * fails in the late-night-ARG window (when UTC already rolled to the next day)
 * with `error 90 "No tiene Acceso"` — silently breaking ALL GR sync. We pin the
 * timezone via Intl (uses node's bundled ICU, so it works on alpine without OS tzdata).
 */
export function isoDate(d: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function str(v: unknown): string | null {
  if (v === null || v === undefined || v === false) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * Decode HTML entities in GR free-text (e.g. `instalaci&oacute;n` → `instalación`,
 * `&#46;` → `.`). GR returns `observaciones` with undecoded named + numeric
 * entities; without this the task description would show raw `&oacute;`. Null in → null out.
 */
function decodeEntities(s: string | null): string | null {
  return s === null ? null : he.decode(s);
}

function numOrNull(v: unknown): number | null {
  const s = str(v);
  if (s === null) return null;
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

/**
 * Extract a phone from GR's `telefonos` object.
 *
 * GR keys this object by phone TYPE and the key VARIES across clients:
 *   { "Telefono": "..." }  → standard (~95%)
 *   { "Movil": "..." }     → mobile, different key
 *   { "": "..." }          → empty key
 *   { "0113...": "..." }   → dirty data, key is a number
 *
 * Strategy: prefer `Telefono` (preserves the 95% case), else the first
 * non-empty value of any key. Returns null when none has content.
 */
function firstPhone(telefonos: unknown): string | null {
  if (!telefonos || typeof telefonos !== 'object') return null;
  const obj = telefonos as Record<string, unknown>;
  const preferred = str(obj.Telefono);
  if (preferred !== null) return preferred;
  for (const v of Object.values(obj)) {
    const s = str(v);
    if (s !== null) return s;
  }
  return null;
}

function nested(obj: Record<string, unknown>, key: string, field: string): string | null {
  const node = obj[key];
  if (node && typeof node === 'object') return str((node as Record<string, unknown>)[field]);
  return null;
}

/**
 * GR returns clients as an OBJECT keyed by id (not an array):
 *   { error:0, resultados:"5090", clientes: { "100011": {...}, ... } }
 */
export function parseClientsResponse(data: unknown): FetchClientsResult {
  const root = (data ?? {}) as Record<string, unknown>;
  const total = parseInt(String(root.resultados ?? '0'), 10) || 0;
  const clientesObj = (root.clientes ?? {}) as Record<string, Record<string, unknown>>;

  const clients: GrClient[] = Object.entries(clientesObj).map(([id, c]) => ({
    grClienteId: id,
    name: str(c.nombre) ?? '',
    documento: str(c.documento),
    email: str(c.mail),
    phone: firstPhone(c.telefonos),
    status: nested(c, 'estado', 'valor'),
    statusCode: nested(c, 'estado', 'codigo'),
    address: nested(c, 'domicilio', 'direccion'),
    city: c.domicilio ? nested(c.domicilio as Record<string, unknown>, 'localidad', 'valor') : null,
    province: c.domicilio ? nested(c.domicilio as Record<string, unknown>, 'provincia', 'valor') : null,
    ultimaModificacion: str(c.ultima_modificacion),
    fechaCreacion: str(c.fecha_creacion),
    raw: c,
  }));

  return { total, clients };
}

/**
 * GR returns contracts as an ARRAY:
 *   { error:"0", contratos: [ { id, nombre, estado, conexiones, ... } ] }
 */
export function parseContractsResponse(data: unknown, grClienteId: string): GrContract[] {
  const root = (data ?? {}) as Record<string, unknown>;
  const list = Array.isArray(root.contratos) ? (root.contratos as Record<string, unknown>[]) : [];

  return list.map(c => ({
    grContratoId: str(c.id) ?? '',
    grClienteId,
    plan: str(c.nombre),
    status: str(c.estado),
    startDate: str(c.inicio),
    address: str(c.domicilio) || null,
    lat: numOrNull(c.lat),
    lng: numOrNull(c.lng),
    pppoeUsername: firstPppoeUser(c.conexiones),
    modificado: str(c.modificado),
    fechaCreacion: null,  // per-client feed does not expose creation date
    vendedor: str(c.vendedor),
    motivoBaja: str(c.motivo_baja),
    raw: c,
  }));
}

/**
 * Parse the GR `contratos` delta response (action:contratos + fecha_tipo:m).
 * Unlike `parseContractsResponse`, each item carries its OWN `cliente_id` —
 * the parser stamps `grClienteId` PER ITEM (not from a caller-supplied parameter).
 * `total` comes from `resultados` (string) for paging.
 */
export function parseContractsDeltaResponse(data: unknown): FetchContractsDeltaResult {
  const root = (data ?? {}) as Record<string, unknown>;
  const total = parseInt(String(root.resultados ?? '0'), 10) || 0;
  const list = Array.isArray(root.contratos) ? (root.contratos as Record<string, unknown>[]) : [];
  const contracts: GrContract[] = list.map(c => ({
    grContratoId: str(c.id) ?? '',
    grClienteId: str(c.cliente_id) ?? '',
    plan: str(c.nombre),
    status: str(c.estado),
    startDate: str(c.inicio),
    address: str(c.domicilio) || null,
    lat: numOrNull(c.lat),
    lng: numOrNull(c.lng),
    pppoeUsername: null,               // global feed does not carry conexiones
    modificado: str(c.modificado),
    fechaCreacion: null,               // GR does not expose fecha_alta in the contratos feed
    vendedor: str(c.vendedor),
    motivoBaja: str(c.motivo_baja),
    raw: c,
  }));
  return { total, contracts };
}

/**
 * Parse the GR `cliente` action response into a normalized GrClientBalance.
 *
 * The real payload structure (captured in Phase 0):
 *   { error:"0", clientes: [ { idcustomer, cuentas: { debt, invoices_qty, payments_url_saldos } } ] }
 *
 * Defensive: returns amount=0 on any missing/malformed data so callers never break.
 * Handles both point-decimal ("65722.07") and AR-locale ("1.234,56") formats.
 */
export function parseClientBalanceResponse(grClienteId: string, data: unknown): GrClientBalance {
  const zero: GrClientBalance = { grClienteId, amount: 0, currency: null, invoicesQty: 0, paymentUrls: {}, invoices: [], raw: {} };

  try {
    const root = (data ?? {}) as Record<string, unknown>;
    const clientes = Array.isArray(root.clientes) ? root.clientes as Record<string, unknown>[] : [];
    if (clientes.length === 0) return zero;

    const cliente = clientes[0];
    const raw = cliente as Record<string, unknown>;
    const cuentas = cliente.cuentas as Record<string, unknown> | undefined;
    if (!cuentas) return { ...zero, raw };

    const debtRaw = str(cuentas.debt);
    const amount = parseArNumber(debtRaw);
    const invoicesQty = parseInt(String(cuentas.invoices_qty ?? '0'), 10) || 0;

    // Extract payment URLs from payments_url_saldos
    const paymentUrls: Record<string, string> = {};
    const urlsObj = cuentas.payments_url_saldos;
    if (urlsObj && typeof urlsObj === 'object') {
      for (const [k, v] of Object.entries(urlsObj as Record<string, unknown>)) {
        if (typeof v === 'string' && v) paymentUrls[k] = v;
      }
    }

    return {
      grClienteId,
      amount,
      currency: amount > 0 ? 'ARS' : null,
      invoicesQty,
      paymentUrls,
      invoices: parseGrInvoices(cuentas.invoices),
      raw,
    };
  } catch {
    return zero;
  }
}

/**
 * Parse `cuentas.invoices[]` into normalized GrInvoice[].
 *
 * Defensive by contract: a non-array (missing/`[]`/malformed) yields `[]` with no
 * throw; individual items that are not objects or lack a `numero` (the identity's
 * required piece) are skipped. Amounts come as real JSON floats; `paymentUrl` is
 * pulled from `payments_url.MercadoPago`.
 */
function parseGrInvoices(invoices: unknown): GrInvoice[] {
  if (!Array.isArray(invoices)) return [];
  const out: GrInvoice[] = [];
  for (const item of invoices) {
    if (!item || typeof item !== 'object') continue;
    const inv = item as Record<string, unknown>;
    const numero = str(inv.numero);
    const tipo = str(inv.tipo);
    const sucursal = str(inv.sucursal);
    // The composite identity is `{tipo}-{sucursal}-{numero}` — all three are required
    // to form a stable grInvoiceId. Skip items missing any part so the key never degrades
    // to "null-null-…" (review #6). GR always supplies all three.
    if (numero === null || tipo === null || sucursal === null) continue;
    out.push({
      tipo,
      sucursal,
      numero,
      moneda: str(inv.moneda),
      fecha: str(inv.fecha),
      fechaVto: str(inv.fecha_vto),
      importe: grFloat(inv.importe),
      saldo: grFloat(inv.saldo),
      urlPdf: str(inv.url_pdf),
      cuponPdf: str(inv.cupon_pdf),
      paymentUrl: grMercadoPagoUrl(inv.payments_url),
    });
  }
  return out;
}

/**
 * GR invoice amounts arrive as real JSON floats (e.g. 35121.37, or -500 for
 * credit notes). Accept the number directly; fall back to parseFloat for a
 * stringified value; 0 on anything unparseable. Unlike `parseArNumber`, these
 * are NOT AR-locale strings.
 */
function grFloat(v: unknown): number {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const s = str(v);
  if (s === null) return 0;
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

/** Pull the MercadoPago link out of a GR `payments_url` object, or null. */
function grMercadoPagoUrl(paymentsUrl: unknown): string | null {
  if (!paymentsUrl || typeof paymentsUrl !== 'object') return null;
  return str((paymentsUrl as Record<string, unknown>).MercadoPago);
}

/**
 * Parse an Argentine or plain-decimal number string to a JS number.
 * Handles:
 *   "65722.07"   → 65722.07  (plain decimal, GR's actual format from Phase 0)
 *   "1.234,56"   → 1234.56   (AR locale: thousands dot, decimal comma)
 *   ""  / null   → 0
 *   0 (numeric)  → 0
 */
function parseArNumber(s: string | null): number {
  if (s === null || s === '') return 0;
  const trimmed = s.trim();
  if (trimmed === '') return 0;

  // AR locale: contains comma (decimal separator in es-AR)
  // Pattern: "1.234,56" — thousands dot, comma decimal
  if (trimmed.includes(',')) {
    // Replace thousands separator (dot) and replace comma with dot
    const normalized = trimmed.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(normalized);
    return isFinite(n) ? n : 0;
  }

  // Plain decimal or integer: "65722.07", "0", "65722"
  const n = parseFloat(trimmed);
  return isFinite(n) ? n : 0;
}

/**
 * GR returns service orders as an OBJECT keyed by order id (not an array):
 *   { error:0, "551": {...}, "552": {...} }
 *
 * Each value is an order object. The street address lives at `domicilio.domicilio`,
 * locality at `domicilio.localidad.valor` (fallback `.codigo`), province at
 * `domicilio.provincia.valor`. `cliente`/`contrato` may be empty/null (e.g. IN-type
 * orders). The top-level `error`/`status`/`resultados` metadata fields are skipped.
 */
export function parseServiceOrdersResponse(data: unknown): GrServiceOrder[] {
  if (!data || typeof data !== 'object') return [];
  const root = data as Record<string, unknown>;

  // Top-level metadata keys that are NOT orders.
  const META_KEYS = new Set(['error', 'status', 'resultados', 'offset', 'cantidad']);

  const orders: GrServiceOrder[] = [];
  for (const [id, value] of Object.entries(root)) {
    if (META_KEYS.has(id)) continue;
    if (!value || typeof value !== 'object') continue;
    const o = value as Record<string, unknown>;

    orders.push({
      grOrdenId: id,
      tipo: str(o.tipo),
      estado: str(o.estado),
      cliente: str(o.cliente),
      contrato: str(o.contrato),
      domicilio: parseOrderDomicilio(o.domicilio),
      fechaCreacion: str(o.creado),
      observaciones: decodeEntities(str(o.observaciones)),
      raw: o,
    });
  }
  return orders;
}

/**
 * Normalize the GR order `domicilio` block. Street is `domicilio` (string),
 * locality/province are nested `{ codigo, valor }` objects (valor preferred).
 * Returns null when the block is absent or not an object.
 */
function parseOrderDomicilio(
  domicilio: unknown,
): { direccion: string | null; localidad: string | null; provincia: string | null } | null {
  if (!domicilio || typeof domicilio !== 'object') return null;
  const d = domicilio as Record<string, unknown>;
  return {
    direccion: str(d.domicilio),
    localidad: nested(d, 'localidad', 'valor') ?? nested(d, 'localidad', 'codigo'),
    provincia: nested(d, 'provincia', 'valor') ?? nested(d, 'provincia', 'codigo'),
  };
}

/** Pull the first PPPoE username out of the GR "conexiones" object. */
function firstPppoeUser(conexiones: unknown): string | null {
  if (!conexiones || typeof conexiones !== 'object') return null;
  for (const [key, val] of Object.entries(conexiones as Record<string, unknown>)) {
    if (key === 'cantidad_conexiones') continue;
    if (val && typeof val === 'object') {
      const user = str((val as Record<string, unknown>).username);
      if (user) return user;
    }
  }
  return null;
}
