import { Ticket, TicketStats, TicketStatus, TicketPriority } from '../entities/ticket';
import { PaginatedResult, PaginatedQuery } from '../../application/dto/pagination';

export interface ListTicketsQuery extends PaginatedQuery {
  search?: string;
  // Phase 2: TicketStatus = string (dynamic catalog), so any name is valid here.
  status?: TicketStatus;
  priority?: TicketPriority;
  customerId?: string;            // habilita "Tickets (N)" por cliente
  assigneeId?: string;            // #25 — filtrar por asignado (excluye no-asignados)
  from?: string;                  // #25 — createdAt >= from (ISO date YYYY-MM-DD)
  to?: string;                    // #25 — createdAt <= fin del día de to
  areaId?: string;                // #49 — filtrar por área
  // #85 — when true returns ONLY archived tickets; default (false/absent) excludes them
  archived?: boolean;
}

export interface CreateTicketData {
  subject: string;
  description: string;
  customerId?: string | null;     // FK (replaces clientId texto libre)
  priority?: TicketPriority;
  assigneeId?: string | null;
  reporterId?: string | null;     // #48 — estampado desde la sesion (req.user.id) en el route
  areaId?: string | null;         // #49 — required in route, optional in port (like reporterId)
}

export interface UpdateTicketData {
  subject?: string;
  description?: string;
  // Phase 2: status is the catalog name string (not a DB id).
  // The repository resolves name→id at the persistence boundary.
  status?: TicketStatus;
  priority?: TicketPriority;
  assigneeId?: string | null;
  areaId?: string | null;         // #49 — null = clear area; undefined = don't touch
}

export interface TicketRepository {
  list(query: ListTicketsQuery): Promise<PaginatedResult<Ticket>>;
  getById(id: string): Promise<Ticket | null>;
  getStats(): Promise<TicketStats>;
  create(data: CreateTicketData): Promise<Ticket>;
  update(id: string, data: UpdateTicketData): Promise<Ticket | null>;
  /**
   * Persist the ticket as closed using the canonical catalog status NAME
   * resolved by the caller (CloseTicket). The repo never hardcodes 'closed' —
   * it writes exactly the name it is given (catalog-aware, casing-safe).
   */
  close(id: string, statusName: string): Promise<Ticket | null>;
  /**
   * #85 — Archive a ticket (must be closed first; validated by ArchiveTicket use case).
   * Sets archivedAt to now. Returns null if not found.
   */
  archive(id: string): Promise<Ticket | null>;
  /**
   * #85 — Hard-delete a ticket. Returns true if deleted, false if not found.
   */
  delete(id: string): Promise<boolean>;
  /**
   * Portfolio (Fase 3) — count OPEN tickets per client for a set of clientIds,
   * in a SINGLE aggregated query (no N+1). "Open" = resolvedAt IS NULL AND archivedAt IS NULL.
   * Returns a Map keyed by clientId; clientIds with zero open tickets MAY be absent (caller defaults to 0).
   */
  countOpenByClientIds(clientIds: string[]): Promise<Map<string, number>>;
}
