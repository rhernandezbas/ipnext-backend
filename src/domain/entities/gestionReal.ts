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

/**
 * One entry of `recibo.aplicaciones[]` — the payment applied to a SINGLE
 * comprobante. `tipo`/`sucursal`/`numero` together form the composite identity
 * `"{tipo}-{sucursal}-{numero}"`, EXACTLY the same identity `Invoice.grInvoiceId`
 * already uses (gr-invoices-sync) — see `grReceiptApplicationInvoiceId()` in
 * `mapGrReceipt.ts`. `importe` is the amount of THIS application (a receipt can
 * pay N comprobantes — finance-growth Fase 1, Decision 0b).
 */
export interface GrReceiptApplication {
  /** GR application id — the object key when `aplicaciones` is dict-keyed-by-id. */
  grApplicationId: string;
  /** Comprobante type, e.g. "FB"/"FA"/"FX"/"ID". Part of the composite identity. */
  tipo: string | null;
  /** Sucursal code. Part of the composite identity. */
  sucursal: string | null;
  /** Invoice number. Part of the composite identity. */
  numero: string | null;
  /** Amount applied to this comprobante (JSON float). */
  importe: number;
  /** Application date "DD-MM-YYYY". */
  fecha: string | null;
}

/**
 * One entry of `recibo.items[]` — a payment-method line (medio de cobro),
 * e.g. a MercadoPago transfer or a bank deposit. fix-wave-2 R1: this is the
 * ONLY node GR reports that represents cash ACTUALLY received — `aplicaciones`
 * is the debt CANCELLED, which can exceed cash when a receipt also carries
 * `retenciones` (tax withholding certificates, never cash). Measured live
 * (June 2026, 4.839 recibos): `SUM(aplicaciones) - SUM(items) - SUM(retenciones)
 * = -0.00` — an exact identity, 0 mismatches.
 */
export interface GrReceiptItem {
  /** Synthetic `${grReceiptId}-item-${key}` — same F11 rationale as `GrReceiptApplication.grApplicationId`: GR's own per-line index is never trusted as a global id. */
  grItemId: string;
  banco: string | null;
  cajaCuentaId: string | null;
  destino: string | null;
  /** Line date "DD-MM-YYYY" (or as GR provides it). */
  fecha: string | null;
  importe: number;
  moneda: string | null;
  numeroTransferencia: string | null;
  tipo: string | null;
}

/**
 * One entry of `recibo.retenciones[]` — a tax-withholding certificate
 * (retiva/retgan/retib/retpat — open vocabulary, no enum) applied against the
 * receipt. fix-wave-2 R1: NEVER cash — a receipt can be 100% retenciones with
 * zero `items` (measured: 7 of 18 June-2026 receipts carrying `retenciones`
 * have NO `items` at all, e.g. recibo `333605`: aplicaciones 20.850,60 =
 * retenciones 20.850,60, cash 0,00). Persisted as its own line so the
 * cobranza/retenciones split stays reversible without re-ingesting history.
 */
export interface GrReceiptRetencion {
  /** Synthetic `${grReceiptId}-ret-${key}` — same F11 rationale as `grApplicationId`. */
  grRetencionId: string;
  tipo: string | null;
  importe: number;
  /** Line date "DD-MM-YYYY" (or as GR provides it), when present. */
  fecha: string | null;
}

/**
 * Normalized GR payment receipt (`recibos` action, finance-growth Fase 1).
 * `fechaAnulacion` is null when the receipt is NOT voided — a receipt whose raw
 * `fecha_anulacion` differs from the GR null-date centinela
 * (`"00-00-0000 00:00:00"`) is a REAL annulment and is EXCLUDED entirely by the
 * parser (`parseReceiptsResponse` in `GestionRealClient.ts`); a `GrReceipt` that
 * reaches the application layer is NEVER voided (design.md Decision 0, gotcha 3).
 */
export interface GrReceipt {
  /** GR receipt id — the object key when the `recibos` root is dict-keyed-by-id. */
  grReceiptId: string;
  /** GR client id this receipt belongs to (raw field `cliente_id`). */
  clienteGrId: string | null;
  /** Collection channel, e.g. "mercadopago"/"manual" — open vocabulary, no enum. */
  recaudador: string | null;
  /**
   * Receipt date, GR wire format "DD-MM-YYYY" — DATE-ONLY. fix-wave-2 LOW: this
   * docblock previously (wrongly) claimed "DD-MM-YYYY HH:MM:SS"; measured live
   * (100/100 June-2026 recibos) `fecha_recibo` NEVER carries a time component —
   * `fecha_confirmacion` is the field that does.
   */
  fechaRecibo: string | null;
  /** Confirmation date "DD-MM-YYYY HH:MM:SS" — this IS the field that carries a time, when GR reports one. */
  fechaConfirmacion: string | null;
  /** Always null here — see the class doc comment above (real annulments never reach this type). */
  fechaAnulacion: string | null;
  observaciones: string | null;
  applications: GrReceiptApplication[];
  /**
   * fix-wave-2 R1 — optional so lightweight pre-existing test fixtures (that
   * predate items/retenciones) keep compiling unchanged; the REAL parser
   * (`GestionRealClient.parseReceiptsResponse`) always populates these (empty
   * array when GR omits the node, never `undefined`). Callers should read via
   * `r.items ?? []` / `r.retenciones ?? []` (see `mapGrReceipt.ts`).
   */
  items?: GrReceiptItem[];
  retenciones?: GrReceiptRetencion[];
}
