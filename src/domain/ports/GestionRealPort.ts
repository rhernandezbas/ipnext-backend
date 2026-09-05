import { GrClient, GrClientBalance, GrContract, GrReceipt, GrServiceOrder } from '../entities/gestionReal';

export interface FetchContractsDeltaParams {
  /** Lower bound "DD-MM-AAAA". */
  fechaDesde: string;
  /** Upper bound "DD-MM-AAAA". */
  fechaHasta: string;
  /**
   * Date axis: 'm' = modification date, 'c' = creation date.
   * The use case always sets this explicitly; defaults to 'm' in the adapter
   * when omitted (backward-compatible with test doubles that call without it).
   */
  fechaTipo?: 'm' | 'c';
  /** Page size — GR caps at 100. */
  cantidad: number;
  offset: number;
}

export interface FetchContractsDeltaResult {
  /** Total rows matching (GR "resultados"), drives paging. */
  total: number;
  contracts: GrContract[];
}

export interface FetchClientsParams {
  /** 'c' = creación, 'm' = modificación. Omit for a full unfiltered scan. */
  fechaTipo?: 'c' | 'm';
  /** Lower bound, format "DD-MM-AAAA". Required when fechaTipo is set. */
  fechaDesde?: string;
  /** Upper bound, format "DD-MM-AAAA". */
  fechaHasta?: string;
  /** Estado filter: 1=Activo, 2=Deudor, 3=Inactivo, 4=Incobrable, 6=Baja. */
  estado?: string;
  /** Page size — GR caps at 100. */
  cantidad: number;
  offset: number;
}

export interface FetchClientsResult {
  /** Total rows matching the filter (GR "resultados"), used to drive paging. */
  total: number;
  clients: GrClient[];
}

/** Params for the `ordenesdeservicio` (service orders) GR action. */
export interface GetServiceOrdersParams {
  /** State filter; default 'PEND'. */
  estado?: string;
  /** Date axis: 'c' = creación, 'm' = modificación, 'co' = cierre. Default 'c'. */
  fechaTipo?: 'c' | 'm' | 'co';
  /** Lower bound, format "DD-MM-AAAA" (now − windowMonths). */
  fechaDesde?: string;
  /** Upper bound, format "DD-MM-AAAA" (today). */
  fechaHasta?: string;
}

/** Params for the `recibos` (payment receipts) GR action — finance-growth Fase 1. */
export interface FetchReceiptsParams {
  /**
   * Lower bound, format "DD-MM-AAAA" — MANDATORY format. Verified live: `recibos`
   * responds HTTP 500 (not error 91) when given an ISO date. Callers must format
   * dates with the same DD-MM-AAAA convention already used by `fetchContractsModifiedSince`.
   */
  fechaDesde: string;
  /** Upper bound, format "DD-MM-AAAA". Same mandatory-format gotcha as `fechaDesde`. */
  fechaHasta: string;
  /** Page size — GR caps at 100. */
  cantidad: number;
  offset: number;
}

export interface FetchReceiptsResult {
  /** Total rows matching the date range (GR "resultados"), drives paging. */
  total: number;
  /** Already excludes receipts with a REAL annulment (design.md Decision 0, gotcha 3). */
  receipts: GrReceipt[];
}

/**
 * ai-assistant-cobranzas (D9) — params for `cliente.recibos_hoy`: a LIVE, per-client GR call,
 * NOT the global `fetchReceipts` delta sync. `grClienteId` is MANDATORY IN THE SIGNATURE
 * (precedent `PortalPaymentsReader`) — an optional anchor would let a caller forget it and leak
 * every client's receipts (PII by omission). Dates use the same `DD-MM-AAAA` convention as
 * `fetchReceipts`/`fetchContractsModifiedSince`.
 */
export interface FetchClientReceiptsParams {
  /** GR client id — REQUIRED, never optional (anti-leak anchor). */
  grClienteId: string;
  /** Lower bound, format "DD-MM-AAAA". */
  fechaDesde: string;
  /** Upper bound, format "DD-MM-AAAA". */
  fechaHasta: string;
}

export interface FetchClientReceiptsResult {
  /** Total rows matching the date range for this client (GR "resultados"). */
  total: number;
  /** Already excludes receipts with a REAL annulment, reusing `parseReceiptsResponse`. */
  receipts: GrReceipt[];
}

/**
 * Upstream port for the Gestión Real external API. The adapter owns auth,
 * transport and payload normalization; the application layer only sees this.
 */
export interface GestionRealPort {
  fetchClients(params: FetchClientsParams): Promise<FetchClientsResult>;
  fetchContractsByClient(grClienteId: string): Promise<GrContract[]>;
  /** Fetch the balance/debt for a single client via the `cliente` action. */
  fetchClientBalance(grClienteId: string): Promise<GrClientBalance>;
  /** Fetch service orders via the `ordenesdeservicio` action, normalized to a flat array. */
  getServiceOrders(params: GetServiceOrdersParams): Promise<GrServiceOrder[]>;
  /**
   * Global contract delta by modification date (action:contratos, fecha_tipo=m).
   * Each item carries its OWN cliente_id — the parser stamps grClienteId PER ITEM.
   */
  fetchContractsModifiedSince(params: FetchContractsDeltaParams): Promise<FetchContractsDeltaResult>;
  /**
   * Global payment-receipt sync by date range (action:recibos), paginated by
   * offset — finance-growth Fase 1, design.md Decision 0. NEVER iterate
   * `fetchClientBalance`'s `invoices[]` per-client for the full population —
   * that endpoint is deuda ABIERTA only (verified live: 0 invoices for a
   * client al día), not a historical feed.
   */
  fetchReceipts(params: FetchReceiptsParams): Promise<FetchReceiptsResult>;
  /**
   * ai-assistant-cobranzas (D9) — `cliente.recibos_hoy`: live, per-client receipt lookup
   * (action:recibos + cliente_id) used to verify a payment proof against GR in real time.
   * NEVER a substitute for `fetchReceipts` (the global delta sync) — this is a separate,
   * per-call, anchored path. Does NOT alter `fetchReceipts`/`FetchReceiptsParams`.
   */
  fetchClientReceipts(params: FetchClientReceiptsParams): Promise<FetchClientReceiptsResult>;
}
