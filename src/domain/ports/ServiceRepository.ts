import { PaginatedResult, PaginatedQuery } from '../../application/dto/pagination';

/**
 * A row in the global services (contracts) listing. Joins the Service row with
 * its owning client's name so the contracts page can render without a second call.
 */
export interface ServiceListItem {
  id: string;
  clientName: string;
  plan: string;
  status: string;
  technology: string | null;
  startDate: string;
}

export interface ListServicesQuery extends PaginatedQuery {
  /** Free-text match against plan and client name (case-insensitive). */
  search?: string;
  /** Exact match against Service.status. */
  status?: string;
  /** Exact match against Service.technology (free-text catalog name). */
  technology?: string;
}

export interface ServiceStats {
  total: number;
  byStatus: Record<string, number>;
}

export interface ServiceRepository {
  /** Global paginated listing across all clients, with optional filters. */
  list(query: ListServicesQuery): Promise<PaginatedResult<ServiceListItem>>;
  /** Returns total count + per-status breakdown. Status values are dynamic (from Gestión Real). */
  stats(): Promise<ServiceStats>;
}
