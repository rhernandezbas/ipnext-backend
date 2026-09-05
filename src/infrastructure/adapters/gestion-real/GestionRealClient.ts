import axios, { AxiosInstance, AxiosResponse } from 'axios';
import crypto from 'crypto';
import he from 'he';
import {
  GestionRealPort,
  FetchClientsParams,
  FetchClientsResult,
  FetchClientReceiptsParams,
  FetchClientReceiptsResult,
  FetchContractsDeltaParams,
  FetchContractsDeltaResult,
  FetchReceiptsParams,
  FetchReceiptsResult,
  GetServiceOrdersParams,
} from '@domain/ports/GestionRealPort';
import {
  GrClient,
  GrClientBalance,
  GrContract,
  GrInvoice,
  GrReceipt,
  GrReceiptApplication,
  GrReceiptItem,
  GrReceiptRetencion,
  GrServiceOrder,
} from '@domain/entities/gestionReal';
import { isRealAnnulment } from '@application/use-cases/finance/financeDates';

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

  /**
   * finance-growth Fase 1 (design.md Decision 0) — global payment-receipt sync
   * via the `recibos` action, paginated by offset. `fechaDesde`/`fechaHasta`
   * are forwarded EXACTLY as given (caller-formatted DD-MM-AAAA) — `recibos`
   * responds HTTP 500 (not error 91) on an ISO date, so this method never
   * reformats or re-derives them.
   */
  async fetchReceipts(params: FetchReceiptsParams): Promise<FetchReceiptsResult> {
    const { data } = await this.postWithRetry({
      action: 'recibos',
      fecha_desde: params.fechaDesde,
      fecha_hasta: params.fechaHasta,
      cantidad: params.cantidad,
      offset: params.offset,
    });
    return parseReceiptsResponse(data, params.offset);
  }

  /**
   * ai-assistant-cobranzas (4.7 / D9) — `cliente.recibos_hoy`: los recibos de UN cliente, EN
   * VIVO, para verificar contra GR el comprobante que el cliente acaba de mandar.
   *
   * Es la MISMA `action:'recibos'` de la ingesta global, con dos diferencias que son la razón
   * de ser del método:
   *
   *  - **`cliente_id` es obligatorio en la firma** (`FetchClientReceiptsParams`). Un
   *    `clienteId` opcional sobre `fetchReceipts` habría alcanzado técnicamente, y un caller
   *    que se lo olvidara se llevaría los recibos de TODOS los clientes: una fuga de PII por
   *    omisión. El ancla no se delega al llamador.
   *  - **Los anulados se excluyen ACÁ.** `parseReceiptsResponse` pasa `fecha_anulacion` en
   *    crudo a propósito (es `infrastructure/`, no decide reglas de negocio) y deja que
   *    `mapGrReceipt` derive `anulado` río abajo — pero este camino NO pasa por el mapper:
   *    sus recibos van directo a "¿entró este pago?". Contar un recibo dado de baja como un
   *    pago recibido es decirle "listo, ya está" a alguien cuyo pago se anuló.
   *
   * Las fechas viajan EXACTAMENTE como se las pasaron (DD-MM-AAAA): `recibos` responde HTTP
   * 500 —no un error 91— ante una fecha ISO. `total` es el `resultados` de GR, ANTES del
   * filtro de anulados: es lo que GR dice haber encontrado, no lo que nosotros conservamos.
   */
  async fetchClientReceipts(params: FetchClientReceiptsParams): Promise<FetchClientReceiptsResult> {
    const { data } = await this.postWithRetry({
      action: 'recibos',
      cliente_id: Number(params.grClienteId),
      fecha_desde: params.fechaDesde,
      fecha_hasta: params.fechaHasta,
    });
    const parsed = parseReceiptsResponse(data);
    return {
      total: parsed.total,
      receipts: parsed.receipts.filter((r) => !isRealAnnulment(r.fechaAnulacion, r.grReceiptId)),
    };
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
 * ⚠️ FIX-1 (CRITICAL, 2026-08-04) — **NO devuelve más un "zero defensivo"**.
 *
 * Esta función devolvía `{ amount: 0, invoices: [] }` ante CUALQUIER payload que
 * no reconociera, y ese objeto significa **"el cliente no debe nada"**, no "no
 * tengo datos". Río abajo, ese valor viaja a `upsertInvoices`, que es
 * **replace-all** ⇒ **borraba todas las facturas del cliente**. Cadena verificada
 * en vivo contra prod:
 *
 *   1. GR responde **HTTP 200 con sobre de error** — reproducido mandando el
 *      password diario de ayer (el incidente del MD5 vs. contenedor en UTC):
 *      `{"error":"90","descripcion":"No tiene Acceso"}`, sin nodo `clientes`.
 *      Un cliente inexistente da `{"error":"2","status":"No se encontraron clientes"}`.
 *   2. El parser lo degradaba a `zero` SIN tirar ⇒ ningún `catch` lo atajaba.
 *   3. El guard `invoices.length > 0 || amount <= 0` lo dejaba pasar por `0 <= 0`.
 *   4. `deleteMany({ NOT: { grInvoiceId: { in: [] } } })` matchea TODO (medido con
 *      el Prisma real de prod: 6 facturas → 6 matcheadas).
 *   ⇒ un blip de GR vaciaba el espejo con `SyncState.lastResult = 'ok'`.
 *
 * Ahora **TIRA** ante un payload no autoritativo, alineándose con su hermano
 * `parseReceiptsResponse` (que ya lo hacía). Los dos callers —`RefreshDebtorBalances`
 * y `RefreshClientBalanceIfStale`— ya capturan y sirven lo guardado: el fallo va
 * hacia **"no toco nada"** en vez de hacia "borro todo".
 *
 * Lo que SÍ sigue devolviendo `amount: 0` es la deuda cero LEGÍTIMA (`error: "0"`
 * + `cuentas.debt = 0`), porque ese borrado es el correcto: es el cliente que pagó.
 * Medido: de 32 clientes reales muestreados, 32 traen `cuentas` y 12 tienen deuda 0.
 *
 * Maneja formato punto-decimal ("65722.07") y AR-locale ("1.234,56").
 *
 * @throws Error si el payload no es una respuesta autoritativa sobre este cliente.
 */
export function parseClientBalanceResponse(grClienteId: string, data: unknown): GrClientBalance {
  const zero: GrClientBalance = { grClienteId, amount: 0, currency: null, invoicesQty: 0, paymentUrls: {}, invoices: [], raw: {} };

  if (data === null || data === undefined || typeof data !== 'object') {
    throw new Error(`GR cliente ${grClienteId}: respuesta no interpretable (${typeof data})`);
  }

  const root = data as Record<string, unknown>;

  // Sobre de error. Mismo criterio que `parseReceiptsResponse`.
  const errorCode = root.error;
  if (errorCode !== undefined && errorCode !== null && String(errorCode) !== '0') {
    const detalle = str(root.descripcion) ?? str(root.status) ?? '(sin descripcion)';
    throw new Error(`GR cliente ${grClienteId}: error ${errorCode}: ${detalle}`);
  }

  const clientes = Array.isArray(root.clientes) ? (root.clientes as Record<string, unknown>[]) : [];
  // Preguntamos por UN cliente concreto: que no vuelva ninguno no es "no debe
  // nada", es "no hay respuesta sobre él".
  if (clientes.length === 0) {
    throw new Error(`GR cliente ${grClienteId}: la respuesta no trae el cliente`);
  }

  const cliente = clientes[0];
  const raw = cliente as Record<string, unknown>;
  const cuentasRaw = (cliente as Record<string, unknown>).cuentas;
  // `cuentas` es donde vive la deuda: sin ese nodo no sabemos NADA de su saldo,
  // así que no podemos afirmar cero. Medido en vivo: 36/36 clientes reales lo traen.
  //
  // Chequeo de TIPO, no de truthiness: `if (!cuentas)` dejaba pasar cualquier valor
  // truthy no-objeto (`cuentas: "sin datos"`), y ahí `cuentas.debt` es `undefined`
  // ⇒ amount 0 ⇒ borrado masivo. Mismo patrón que el guard del root, dos líneas arriba.
  if (!cuentasRaw || typeof cuentasRaw !== 'object') {
    throw new Error(`GR cliente ${grClienteId}: la respuesta no trae el nodo cuentas`);
  }
  const cuentas = cuentasRaw as Record<string, unknown>;

  {
    // ⚠️ FIX-1b — el hermano que FIX-1 dejó vivo: guardaba el CONTENEDOR, no el VALOR.
    const amount = parseGrDebtStrict(cuentas.debt, grClienteId);
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
  }
  // Sin `catch` a propósito: cualquier throw inesperado significa que NO
  // entendimos la respuesta, y en ese caso hay que fallar hacia "no toco nada".
  // El `catch { return zero }` que había acá se tragaba el fallo y lo convertía
  // en la afirmación "no debe nada", que río abajo BORRA las facturas.
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
 * credit notes) OR as a plain-decimal string (measured 100% of
 * aplicaciones/items/retenciones in the `recibos` action: `"19999.00"`).
 *
 * fix-wave-2 LOW: this used to `parseFloat` a string directly with NO locale
 * guard — safe today only because the measured sample never contained a
 * comma, but this file's OWN `parseArNumber` exists precisely because GR
 * emits AR-locale strings ("1.234,56" — thousands dot, decimal COMMA) on
 * OTHER nodes. `parseFloat("1.234,56")` silently reads only the `"1.234"`
 * prefix (stops at the comma) → **1000x undercounts money**, with no error,
 * no warning — exactly the "fail-open to zero/garbage in silence" pattern
 * this codebase explicitly refuses for money. Delegates to `parseArNumber`
 * so a stray comma anywhere in `recibos` money fields is parsed CORRECTLY
 * instead of truncated.
 */
function grFloat(v: unknown): number {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  return parseArNumber(str(v));
}

/** Pull the MercadoPago link out of a GR `payments_url` object, or null. */
function grMercadoPagoUrl(paymentsUrl: unknown): string | null {
  if (!paymentsUrl || typeof paymentsUrl !== 'object') return null;
  return str((paymentsUrl as Record<string, unknown>).MercadoPago);
}

/**
 * Parsea `cuentas.debt` de forma ESTRICTA: sin dato o dato ilegible ⇒ **tira**.
 *
 * `parseArNumber` (abajo) devuelve `0` ante `null`, `''` y cualquier basura no
 * numérica. Para casi todos los campos eso está bien; para **`debt` es letal**,
 * porque `0` no significa "no sé": significa **"no debe nada"**, y río abajo el
 * guard `amount <= 0` habilita un `upsertInvoices` replace-all que **borra todas
 * las facturas del cliente**.
 *
 * Que `debt` siempre venga numérico es una premisa NO verificable: medido contra
 * GR en vivo sobre 36 clientes reales, `debt` vino string en 36/36 — pero sus
 * hermanos de plata del MISMO nodo `cuentas` vinieron `debt_uss: null` en 36/36,
 * `duedebt: ''` en 36/36 y `noduedebt: ''` en 36/36. O sea que GR emite `null` y
 * `''` en campos de plata de ese nodo de forma universal.
 *
 * Falla hacia "no toco nada" en vez de hacia "borro todo".
 */
function parseGrDebtStrict(rawDebt: unknown, grClienteId: string): number {
  if (typeof rawDebt === 'number') {
    if (!isFinite(rawDebt)) {
      throw new Error(`GR cliente ${grClienteId}: cuentas.debt no es finito (${rawDebt})`);
    }
    return rawDebt;
  }

  const s = str(rawDebt);
  if (s === null) {
    // null, undefined, ausente o cadena vacía. NO es cero: es sin dato.
    throw new Error(`GR cliente ${grClienteId}: cuentas.debt ausente o vacio — sin dato, no es deuda cero`);
  }

  // El formato se valida SIEMPRE, no solo cuando el número da 0.
  //
  // La versión anterior sólo validaba con `n === 0`, pero el gatillo destructivo
  // río abajo es `amount <= 0` — **no `=== 0`**. Cualquier basura que `parseFloat`
  // leyera con prefijo negativo se salteaba la validación entera y caía justo en
  // el replace-all: `"-500 nota de credito"` → `-500` → `amount <= 0` → borra
  // todas las facturas. La MISMA basura con un 0 adelante (`"0abc"`) sí tiraba.
  // Otra vez la instancia en lugar de la clase.
  if (!FORMATO_MONEDA_GR.test(s)) {
    throw new Error(`GR cliente ${grClienteId}: cuentas.debt no numerico (${JSON.stringify(s)})`);
  }
  // Miles AR sin coma decimal (`"1.234"`) es AMBIGUO: puede ser 1,234 o 1234, y
  // `parseArNumber` lo lee como 1,234 — un error de MIL VECES sobre plata. Ante
  // ambigüedad de plata no se adivina: se falla hacia "no toco nada".
  //
  // Pero solo es ambiguo cuando las dos lecturas DIFIEREN: en `"0.000"` las dos
  // dan cero, y rechazarlo sería un falso negativo que deja a ese cliente sin
  // refrescar nunca — o sea, el bug original por otra puerta.
  if (FORMATO_MILES_AMBIGUO.test(s)) {
    const comoDecimal = parseFloat(s);
    const comoMilesAr = parseFloat(s.replace(/\./g, ''));
    if (comoDecimal !== comoMilesAr) {
      throw new Error(
        `GR cliente ${grClienteId}: cuentas.debt ambiguo (${JSON.stringify(s)}) — ` +
          `un punto seguido de exactamente 3 digitos puede ser ${comoDecimal} o ${comoMilesAr}`,
      );
    }
  }
  return parseArNumber(s);
}

/**
 * Formatos de plata que GR emite y que `parseArNumber` interpreta BIEN:
 *   - entero:                 `1234`, `-500`
 *   - decimal plano:          `0.00`, `127561.28`  ← el que se midió en vivo (36/36)
 *   - decimal con coma:       `1,5`
 *   - miles AR CON decimales: `1.234,56`, `1.234.567,89`
 *
 * Todo lo demás tira. En particular quedan afuera `"1,234.56"` (locale EN, que se
 * leía como **1.23456** en silencio) y `"1e5"`.
 */
const FORMATO_MONEDA_GR = /^-?(\d+|\d{1,3}(\.\d{3})+)([.,]\d+)?$/;

/** Un punto + exactamente 3 dígitos y nada más: `"1.234"`. Miles AR o decimal, indistinguible. */
const FORMATO_MILES_AMBIGUO = /^-?\d{1,3}\.\d{3}$/;

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

/**
 * Normalize a GR node that may be an ARRAY or a dict keyed-by-id into a
 * uniform `{key, value}` list. Same defensive idiom already used for
 * `clientesObj`/`parseServiceOrdersResponse` — the forma exacta of the
 * `recibos` root/`aplicaciones` node was NOT confirmed live (proposal,
 * pregunta NO-bloqueante #3), so this handles BOTH from day one.
 */
function toEntriesList(node: unknown): Array<{ key: string; value: unknown }> {
  if (Array.isArray(node)) {
    return node.map((value, idx) => ({ key: String(idx), value }));
  }
  if (node && typeof node === 'object') {
    return Object.entries(node as Record<string, unknown>).map(([key, value]) => ({ key, value }));
  }
  return [];
}

/**
 * Parse the GR `recibos` action response (finance-growth Fase 1, design.md
 * Decision 0). Defensive against dict-keyed-by-id OR array root/aplicaciones
 * nodes (gotcha #2).
 *
 * gr-receipt-annulment (design.md Decision 3.1) — a receipt with a REAL
 * annulment (`fecha_anulacion` distinct from the GR centinela
 * `"00-00-0000 00:00:00"`) is NO LONGER excluded here. This parser is
 * `infrastructure/` — it should not decide domain business rules; it now
 * passes `fecha_anulacion` through RAW (`fechaAnulacion`) and lets
 * `mapGrReceipt` (application/, via `isRealAnnulment`) derive the `anulado`
 * flag. This was the ACTUAL bug the card described ("recibo anulado sigue
 * visible"): a voided receipt never reached the mapper at all, so `anulado`
 * stayed hardcoded `false` forever, even after this parser skipped it.
 *
 * fix-wave-1 F3: GR reports ITS OWN errors with HTTP 200 — measured live:
 * `POST {action:"cuenta_corriente"}` → 200 `{"error":"91","descripcion":"No Se
 * indicó la Acción"}`, no `recibos` node. Silently reading that as `{total:0,
 * receipts:[]}` is INDISTINGUISHABLE from a legitimately empty date range —
 * the delta lane would then persist a plain cursor (days lost forever) and the
 * backfill lane would advance past a whole month (163 months in ~55 minutes of
 * GR errors, observed). A non-zero `error` MUST throw so the caller's
 * try/catch records `lastResult: error:` and the cursor does NOT advance. A
 * legitimate empty TAIL page (measured: offset=900, total=828) returns
 * `error:0` with no `recibos` node — that must NOT throw (see F12 guard,
 * `offset < total`, applied by the callers, not here).
 *
 * `pageOffset` (fix-wave-1 F11, secondary/"mismo criterio" finding): ONLY
 * used as a disambiguator for the array-root fallback key below, when an
 * individual receipt lacks its own `id`. A bare array index is unique only
 * WITHIN one page; across pages of the same paginated scan (`offset` varies,
 * `key` resets to "0", "1", ...) two different receipts could otherwise
 * collide on the same fallback grReceiptId. Defaults to 0 for callers that
 * don't page (e.g. direct unit tests).
 */
export function parseReceiptsResponse(data: unknown, pageOffset = 0): FetchReceiptsResult {
  const root = (data ?? {}) as Record<string, unknown>;
  const errorCode = root.error;
  if (errorCode !== undefined && errorCode !== null && String(errorCode) !== '0') {
    const descripcion = str(root.descripcion) ?? '(sin descripcion)';
    throw new Error(`GR recibos error ${errorCode}: ${descripcion}`);
  }

  const total = parseInt(String(root.resultados ?? '0'), 10) || 0;
  // A dict-keyed root's `key` IS the real GR id — safe to use verbatim. An
  // array root's `key` is a bare POSITIONAL index — only unique WITHIN this
  // page, so the fallback (no `raw.id`) must fold in `pageOffset` too.
  //
  // fix-wave-3 LOW — measured live against 100 real recibos: `recibos`,
  // `aplicaciones`, `items`, and `retenciones` are ALL dict-keyed in every
  // sample, and their keys are real GR ids, GLOBALLY unique across ALL
  // sampled receipts (0 reused, e.g. `186316`/`550823`/`186389`). The
  // `rootIsArray` branch below (and its `parseReceiptItems`/
  // `parseReceiptRetenciones` siblings) is therefore CONFIRMED DEAD CODE
  // against the real GR API today — kept as defense-in-depth in case GR ever
  // changes its response shape, not because it is reachable now. Documented
  // here so this is a deliberate, known-inert guard, not an open risk.
  const rootIsArray = Array.isArray(root.recibos);

  const receipts: GrReceipt[] = [];
  for (const { key, value } of toEntriesList(root.recibos)) {
    if (!value || typeof value !== 'object') continue;
    const raw = value as Record<string, unknown>;

    // F2: the client id is NESTED at `cliente.cliente_id` — measured 100/100
    // live recibos, NEVER at the receipt root as `cliente_id`.
    const grReceiptId = str(raw.id) ?? (rootIsArray ? `page${pageOffset}-${key}` : key);
    receipts.push({
      grReceiptId,
      clienteGrId: nested(raw, 'cliente', 'cliente_id'),
      recaudador: str(raw.recaudador),
      // F1: the field is `fecha_recibo`, NOT `fecha` — measured 100/100 live
      // recibos. `fecha` does not exist on this node; reading it silently
      // produced a null `DateTime?` on every row (no throw, no signal).
      fechaRecibo: str(raw.fecha_recibo),
      fechaConfirmacion: str(raw.fecha_confirmacion),
      // gr-receipt-annulment (design.md Decision 3.1) — RAW pass-through, no
      // longer hardcoded `null`. `mapGrReceipt` derives `anulado` from this
      // via `isRealAnnulment`.
      fechaAnulacion: str(raw.fecha_anulacion),
      observaciones: decodeEntities(str(raw.observaciones)),
      applications: parseReceiptApplications(raw.aplicaciones, grReceiptId),
      // fix-wave-2 R1: `items`/`retenciones` were previously discarded entirely
      // — `aplicaciones` (debt cancelled) is NOT cash; `items` is the only node
      // GR reports that IS cash, and `retenciones` are tax certificates, never
      // cash. Ground truth (June 2026, 4.839 recibos): SUM(aplicaciones) -
      // SUM(items) - SUM(retenciones) = -0.00, exact identity. Discarding these
      // overstated collected cash by exactly the retenciones total (0.931%,
      // $1.376.248,31 in June alone) and, unpersisted, was irrecoverable
      // without re-ingesting all 163 months of history.
      items: parseReceiptItems(raw.items, grReceiptId),
      retenciones: parseReceiptRetenciones(raw.retenciones, grReceiptId),
    });
  }

  return { total, receipts };
}

/**
 * Parse one receipt's `items` node (dict OR array, see `toEntriesList`) — the
 * payment-method lines that represent CASH actually received (fix-wave-2 R1).
 * Same F11 identity idiom as `parseReceiptApplications`: the synthetic
 * `${grReceiptId}-item-${key}` is ALWAYS used, GR's own per-line `id`/index is
 * never trusted as a global key.
 */
function parseReceiptItems(node: unknown, grReceiptId: string): GrReceiptItem[] {
  const out: GrReceiptItem[] = [];
  for (const { key, value } of toEntriesList(node)) {
    if (!value || typeof value !== 'object') continue;
    const i = value as Record<string, unknown>;
    out.push({
      grItemId: `${grReceiptId}-item-${key}`,
      banco: str(i.banco),
      cajaCuentaId: str(i.caja_cuenta_id),
      destino: str(i.destino),
      fecha: str(i.fecha),
      importe: grFloat(i.importe),
      moneda: str(i.moneda),
      numeroTransferencia: str(i.numero_transferencia),
      tipo: str(i.tipo),
    });
  }
  return out;
}

/**
 * Parse one receipt's `retenciones` node (dict OR array) — tax-withholding
 * certificates, NEVER cash (fix-wave-2 R1). Same F11 identity idiom: synthetic
 * `${grReceiptId}-ret-${key}`.
 */
function parseReceiptRetenciones(node: unknown, grReceiptId: string): GrReceiptRetencion[] {
  const out: GrReceiptRetencion[] = [];
  for (const { key, value } of toEntriesList(node)) {
    if (!value || typeof value !== 'object') continue;
    const r = value as Record<string, unknown>;
    out.push({
      grRetencionId: `${grReceiptId}-ret-${key}`,
      tipo: str(r.tipo),
      importe: grFloat(r.importe),
      fecha: str(r.fecha),
    });
  }
  return out;
}

/**
 * Parse one receipt's `aplicaciones` node (dict OR array, see `toEntriesList`).
 *
 * fix-wave-1 F11 (convergent finding, 2 reviewers): the identity is ALWAYS the
 * synthetic `${grReceiptId}-${key}` — GR's own `aplicaciones[].id` is NEVER
 * trusted, even when present. GR's `id` here is commonly just the per-receipt
 * LINE INDEX ("1", "2", ...), not a globally unique value; using it as a
 * global PK means two unrelated receipts whose first application both report
 * `id:"1"` collide, and the second `upsert` silently overwrites the first
 * one's real collected revenue with no error. The synthetic key is exactly as
 * unique as it needs to be (scoped to the already-unique `grReceiptId`) and
 * never depends on an unverified GR uniqueness guarantee.
 */
function parseReceiptApplications(node: unknown, grReceiptId: string): GrReceiptApplication[] {
  const out: GrReceiptApplication[] = [];
  for (const { key, value } of toEntriesList(node)) {
    if (!value || typeof value !== 'object') continue;
    const a = value as Record<string, unknown>;
    out.push({
      grApplicationId: `${grReceiptId}-${key}`,
      tipo: str(a.tipo),
      sucursal: str(a.sucursal),
      numero: str(a.numero),
      importe: grFloat(a.importe),
      fecha: str(a.fecha),
    });
  }
  return out;
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
