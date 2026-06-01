import { PaginatedResult, PaginatedQuery } from '../../application/dto/pagination';

/**
 * A row in the global contracts listing. Joins the Contract row with
 * its owning client's name so the contracts page can render without a second call.
 */
export interface ContractListItem {
  id: string;
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
}
