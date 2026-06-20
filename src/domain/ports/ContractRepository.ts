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

export interface ContractRepository {
  /** Global paginated listing across all clients, with optional filters. */
  list(query: ListContractsQuery): Promise<PaginatedResult<ContractListItem>>;
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
}
