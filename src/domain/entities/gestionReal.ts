/**
 * Normalized shapes coming from the Gestión Real (GR) upstream API.
 *
 * GR returns clients as an object keyed by id and contracts as an array; the
 * adapter normalizes both into these flat structures so the application layer
 * never sees the raw GR payload quirks.
 */

export interface GrClient {
  /** GR client id — the object key in clientes_consulta (e.g. "100011"). */
  grClienteId: string;
  name: string;
  documento: string | null;
  email: string | null;
  phone: string | null;
  /** estado.valor — Activo / Deudor / Inactivo / Incobrable / Baja. */
  status: string | null;
  /** estado.codigo — 1 / 2 / 3 / 4 / 6. */
  statusCode: string | null;
  address: string | null;
  city: string | null;
  province: string | null;
  /** Raw GR modification timestamp "DD-MM-YYYY HH:MM:SS". */
  ultimaModificacion: string | null;
  /** Full GR payload, persisted into Client.customAttributes for fidelity. */
  raw: Record<string, unknown>;
}

export interface GrContract {
  /** GR contract id. */
  grContratoId: string;
  /** GR client id this contract belongs to. */
  grClienteId: string;
  /** nombre — the plan name. */
  plan: string | null;
  /** estado — Vigente / Baja / ... */
  status: string | null;
  /** inicio "DD-MM-YYYY". */
  startDate: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  pppoeUsername: string | null;
  /** Raw GR modification timestamp "DD-MM-YYYY HH:MM:SS". */
  modificado: string | null;
  raw: Record<string, unknown>;
}
