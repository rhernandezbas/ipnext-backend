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

/**
 * Normalized balance from the GR `cliente` action.
 * amount = 0 means no outstanding debt; null fields = unknown/not-yet-fetched.
 */
export interface GrClientBalance {
  grClienteId: string;
  /** Outstanding debt total in the local currency (ARS). 0 = no debt. */
  amount: number;
  /** Currency code, e.g. "ARS". Null when GR omits it. */
  currency: string | null;
  /** Number of outstanding invoices. */
  invoicesQty: number;
  /** Payment URLs by provider (e.g. MercadoPago). */
  paymentUrls?: Record<string, string>;
  /** Full raw `cliente` payload for debug/fidelity. */
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

/**
 * Normalized service order ("orden de servicio") from the GR `ordenesdeservicio`
 * action. GR returns these as an object keyed by order id; the adapter flattens
 * each into this shape. Optional fields are `null` (never `undefined`) so the
 * application layer can rely on explicit presence checks.
 */
export interface GrServiceOrder {
  /** GR order id — the object key in the response (e.g. "551"). */
  grOrdenId: string;
  /** Order type — "CI" (instalación) | "CO" | "BA" | "IN" | ... */
  tipo: string | null;
  /** Order state — e.g. "PEND". */
  estado: string | null;
  /** GR client id this order belongs to. */
  cliente: string | null;
  /** GR contract id this order belongs to. */
  contrato: string | null;
  /** Installation address; null when GR omits the domicilio block. */
  domicilio: {
    direccion: string | null;
    localidad: string | null;
    provincia: string | null;
  } | null;
  /** Creation date "DD-MM-YYYY" (or as GR provides it). */
  fechaCreacion: string | null;
  /** Full raw GR payload for the order, for debug/fidelity. */
  raw: Record<string, unknown>;
}
