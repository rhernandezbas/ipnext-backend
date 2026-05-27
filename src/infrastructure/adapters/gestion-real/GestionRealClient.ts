import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { GestionRealPort, FetchClientsParams, FetchClientsResult } from '@domain/ports/GestionRealPort';
import { GrClient, GrClientBalance, GrContract } from '@domain/entities/gestionReal';

export interface GestionRealClientOptions {
  baseUrl: string;
  cuit: string;
  secret: string;
  /** Injectable clock for deterministic password tests. */
  now?: () => Date;
  timeoutMs?: number;
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

  constructor(opts: GestionRealClientOptions) {
    this.cuit = opts.cuit;
    this.secret = opts.secret;
    this.now = opts.now ?? (() => new Date());
    this.http = axios.create({
      baseURL: opts.baseUrl,
      timeout: opts.timeoutMs ?? 30000,
      headers: { 'Content-Type': 'application/json' },
    });
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

    const { data } = await this.http.post('', payload, { auth: this.auth() });
    return parseClientsResponse(data);
  }

  async fetchContractsByClient(grClienteId: string): Promise<GrContract[]> {
    const { data } = await this.http.post(
      '',
      { action: 'contrato', cli_id: Number(grClienteId), incluye_bajas: 'S' },
      { auth: this.auth() },
    );
    return parseContractsResponse(data, grClienteId);
  }

  async fetchClientBalance(grClienteId: string): Promise<GrClientBalance> {
    const { data } = await this.http.post(
      '',
      { action: 'cliente', cliente_id: Number(grClienteId) },
      { auth: this.auth() },
    );
    return parseClientBalanceResponse(grClienteId, data);
  }
}

/** Date → "YYYY-MM-DD" for the daily password. */
export function isoDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined || v === false) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function numOrNull(v: unknown): number | null {
  const s = str(v);
  if (s === null) return null;
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
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
    phone: nested(c, 'telefonos', 'Telefono'),
    status: nested(c, 'estado', 'valor'),
    statusCode: nested(c, 'estado', 'codigo'),
    address: nested(c, 'domicilio', 'direccion'),
    city: c.domicilio ? nested(c.domicilio as Record<string, unknown>, 'localidad', 'valor') : null,
    province: c.domicilio ? nested(c.domicilio as Record<string, unknown>, 'provincia', 'valor') : null,
    ultimaModificacion: str(c.ultima_modificacion),
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
    raw: c,
  }));
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
  const zero: GrClientBalance = { grClienteId, amount: 0, currency: null, invoicesQty: 0, paymentUrls: {}, raw: {} };

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
      raw,
    };
  } catch {
    return zero;
  }
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
