import { Ticket, TicketStats } from '../entities/ticket';
import { PaginatedResult, PaginatedQuery } from '../../application/dto/pagination';

export interface ListTicketsQuery extends PaginatedQuery {
  search?: string;
  status?: string;
  priority?: string;
}

export interface CreateTicketData {
  subject: string;
  clientId: string;
  priority: 'alta' | 'media' | 'baja';
  description: string;
  assignedTo?: string;
}

export interface TicketRepository {
  list(query: ListTicketsQuery): Promise<PaginatedResult<Ticket>>;
  getStats(): Promise<TicketStats>;
  create(data: CreateTicketData): Promise<Ticket>;
}
