import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { GestionRealPort, FetchClientsParams, FetchClientsResult } from '@domain/ports/GestionRealPort';
import { GrClient, GrContract } from '@domain/entities/gestionReal';

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
