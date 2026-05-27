import { Ticket, TicketStats, TicketStatus, TicketPriority } from '../entities/ticket';
import { PaginatedResult, PaginatedQuery } from '../../application/dto/pagination';

export interface ListTicketsQuery extends PaginatedQuery {
  search?: string;
  status?: TicketStatus;
  priority?: TicketPriority;
  customerId?: string;            // habilita "Tickets (N)" por cliente
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
