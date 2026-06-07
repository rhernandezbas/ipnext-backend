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
}

export interface CreateTicketData {
  subject: string;
  description: string;
  customerId?: string | null;     // FK (replaces clientId texto libre)
  priority?: TicketPriority;
  assigneeId?: string | null;
}

export interface UpdateTicketData {
  subject?: string;
  description?: string;
  // Phase 2: status is the catalog name string (not a DB id).
  // The repository resolves name→id at the persistence boundary.
  status?: TicketStatus;
  priority?: TicketPriority;
  assigneeId?: string | null;
}

export interface TicketRepository {
  list(query: ListTicketsQuery): Promise<PaginatedResult<Ticket>>;
  getById(id: string): Promise<Ticket | null>;
  getStats(): Promise<TicketStats>;
  create(data: CreateTicketData): Promise<Ticket>;
  update(id: string, data: UpdateTicketData): Promise<Ticket | null>;
  close(id: string): Promise<Ticket | null>;
}
