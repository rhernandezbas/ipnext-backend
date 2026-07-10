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
  /**
   * Raw GR creation timestamp "DD-MM-YYYY HH:MM:SS" (clientes_consulta field
   * `fecha_creacion`; legacy rows hold the "00-00-0000 00:00:00" placeholder).
   * Needed because the delta scans by creation date too (clients created
   * without ultima_modificacion are invisible to the modification delta).
   */
  fechaCreacion: string | null;
  /** Full GR payload, persisted into Client.customAttributes for fidelity. */
  raw: Record<string, unknown>;
}

/**
 * Normalized invoice from the GR `cliente` action (`cuentas.invoices[]`).
 *
 * GR gives NO status and NO atomic id — identity is the composite
 * `"{tipo}-{sucursal}-{numero}"` and status is DERIVED from `saldo` + `fechaVto`.
 * Amounts arrive as real JSON floats; dates as "DD-MM-YYYY" strings (parsed in
 * Argentina time downstream). All optional string fields are `null` when GR omits them.
 */
export interface GrInvoice {
  /** Comprobante type, e.g. "FB". Part of the composite identity. */
  tipo: string | null;
  /** Sucursal code, e.g. "00010". Part of the composite identity. */
  sucursal: string | null;
  /** Invoice number, e.g. "000074035". NOT unique on its own. */
  numero: string;
  /** Currency code, e.g. "PES". */
  moneda: string | null;
  /** Issue date "DD-MM-YYYY". */
  fecha: string | null;
  /** Due date "DD-MM-YYYY". */
  fechaVto: string | null;
  /** Total amount (JSON float). */
  importe: number;
  /** Outstanding balance (JSON float; may be negative for credit notes). */
  saldo: number;
  /** Link to the invoice PDF. */
  urlPdf: string | null;
  /** Link to the payment coupon PDF. */
  cuponPdf: string | null;
  /** MercadoPago payment link (from `payments_url.MercadoPago`). */
  paymentUrl: string | null;
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
  /**
   * The client's invoices as returned by GR in the SAME payload
   * (`cuentas.invoices[]`). Empty when GR omits/returns none. Never undefined.
   */
  invoices: GrInvoice[];
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
  /**
   * Raw GR creation timestamp "DD-MM-YYYY HH:MM:SS" (field `fecha_alta`).
   * Needed for the c-scan delta: GR does NOT set `modificado` on newly created
   * contracts, and fecha_tipo=m EXCLUDES rows with an empty modificado —
   * without the c-scan those contracts never reach the mirror (same as clients).
   * The real GR feed filters server-side; this field lets the in-memory double
   * simulate the c-scan in tests.
   */
  fechaCreacion: string | null;
  /** Nombre del vendedor/agente que dio de alta el contrato (GR field `vendedor`).
   * Nombre crudo, sin normalizar (ej. "CAROLINA ROSALES", "julietapalilla"). */
  vendedor: string | null;
  /**
   * recapture-active-client-match — motivo de baja del contrato (GR field `motivo_baja`,
   * ej. "CAMBIO DE TITULARIDAD"). GR-owned, forward-only: sólo los syncs futuros lo
   * pueblan (sin backfill histórico). `null` cuando GR no lo trae (contrato vigente
   * o feed sin el campo).
   */
  motivoBaja: string | null;
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
  /**
   * Free-text comment on the order (GR field `observaciones`), HTML-entities
   * already decoded. Null when GR omits it or it is blank. Used as the ingested
   * task description for normal (non-needs-review) tasks (#16).
   */
  observaciones: string | null;
  /** Full raw GR payload for the order, for debug/fidelity. */
  raw: Record<string, unknown>;
}
