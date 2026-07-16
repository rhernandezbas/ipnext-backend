import { PaginatedResult, PaginatedQuery } from '../../application/dto/pagination';

/**
 * A row in the global contracts listing. Joins the Contract row with
 * its owning client's name so the contracts page can render without a second call.
 */
export interface ContractListItem {
  id: string;
  /** #55 — external Gestión Real contract id (Contract.grContratoId). null for non-GR rows. */
  code: string | null;
  /** Owning client's id — lets the contracts page deep-link to the customer detail (#56). */
  clientId: string;
  clientName: string;
  plan: string;
  status: string;
  technology: string | null;
  startDate: string;
}

export interface ListContractsQuery extends PaginatedQuery {
  /** Free-text match against plan and client name (case-insensitive). */
  search?: string;
  /** Exact match against Contract.status. */
  status?: string;
  /** Exact match against Contract.technology (free-text catalog name). */
  technology?: string;
}

export interface ContractStats {
  total: number;
  byStatus: Record<string, number>;
}

export interface UpdateContractLocationInput {
  gpsLat?: number | null;
  gpsLng?: number | null;
  gpsPlusCode?: string | null;
}

export interface ContractLocationResult {
  id: string;
  gpsLat: number | null;
  gpsLng: number | null;
  gpsPlusCode: string | null;
}

/**
 * contract-node-ap-auto-assign — result DTO shared by the AUTO assigner and the manual
 * picker (SetContractNetworkAssignment). Never a raw Prisma entity.
 */
export interface ContractNetworkAssignmentResult {
  id: string;
  networkSiteId: string | null;
  accessPointId: string | null;
}

export interface UpdateNetworkAssignmentInput {
  networkSiteId: string | null;
  accessPointId: string | null;
}

export interface ContractRepository {
  /** Global paginated listing across all clients, with optional filters. */
  list(query: ListContractsQuery): Promise<PaginatedResult<ContractListItem>>;
  /**
   * Batch read for Recaptación lead enrichment (anti-N+1): ONE query returning the
   * (clientId, technology, plan, motivoBaja) of EVERY contract owned by any of
   * `clientIds`, across ALL statuses (baja contracts included — no status filter).
   * The raw `technology` column is NULL for every GR contract, so the caller DERIVES
   * the effective tech via `deriveTechnology(technology, plan)` (manual value wins;
   * else classify by plan speed). Dedup / null-empty filtering is the caller's
   * responsibility (use case).
   *
   * `motivoBaja` (recapture-active-client-match, Decisión 6) piggybacks this SAME
   * batch — zero extra query. Tech derivation ignores it; it feeds the source-agnostic
   * `churnReasonTexts` assembled by `ListRecaptureLeads`/`GetRecaptureLead`/
   * `IngestChurnedClients` (the persisted `Contract.motivoBaja`, GR-owned, forward-only).
   */
  findContractTechnologiesByClientIds(
    clientIds: string[],
  ): Promise<Array<{ clientId: string; technology: string | null; plan: string; motivoBaja: string | null }>>;
  /**
   * Every contract's (clientId, technology, plan) across ALL clients and ALL statuses.
   * Feeds the Recaptación `technology` filter: the caller derives the effective
   * technology via `deriveTechnology` and collects the matching clientIds — the raw
   * `Contract.technology` column is NULL for all GR rows, so the filter MUST derive
   * (zero drift with ListContracts). Returns `[]` when there are no contracts.
   */
  findAllContractTechnologies(): Promise<Array<{ clientId: string; technology: string | null; plan: string }>>;
  /** Returns total count + per-status breakdown. Status values are dynamic (from Gestión Real). */
  stats(): Promise<ContractStats>;
  /**
   * #43 — persist the manual-only `name` on a contract. Returns `{ id, name }` on
   * success, or `null` when the contract does not exist. Empty-string normalization
   * to `null` is done at the use-case layer.
   *
   * `name === undefined` is a no-op (W-3): the column is left untouched and the current
   * `{ id, name }` is returned (still `null` when the contract does not exist).
   */
  updateName(id: string, name?: string | null): Promise<{ id: string; name: string | null } | null>;

  /**
   * Mis clientes (Fase 2b) — distinct GR `Contract.vendedor` values, non-null,
   * alphabetically ordered. Feeds the FE dropdown for the agente↔vendedor mapping.
   */
  listDistinctVendedores(): Promise<string[]>;

  /**
   * client-geolocation — update ONLY the Prominense-owned GPS fields on a contract.
   * Whitelist: gpsLat, gpsLng, gpsPlusCode. GR lat/lng are NEVER touched.
   * Returns the updated location result, or null when the contract does not exist.
   */
  updateLocation(id: string, data: UpdateContractLocationInput): Promise<ContractLocationResult | null>;

  /**
   * contract-node-ap-auto-assign — batch read proyectado para el auto-assign (permite
   * detectar "sin-cambio" sin traer el contrato completo). Ids inexistentes se OMITEN del
   * resultado (nunca un error, nunca una fila con valores basura).
   */
  getNetworkAssignments(
    contractIds: string[],
  ): Promise<Array<{ id: string; networkSiteId: string | null; accessPointId: string | null }>>;

  /**
   * contract-node-ap-auto-assign — escribe SOLO networkSiteId/accessPointId (whitelist,
   * jamás campos GR). Compartido por el auto-assign y el picker manual
   * (SetContractNetworkAssignment). `null` limpia el campo. Devuelve `null` si el contrato
   * no existe.
   */
  updateNetworkAssignment(
    id: string,
    data: UpdateNetworkAssignmentInput,
  ): Promise<ContractNetworkAssignmentResult | null>;
}
