import { TicketRepository, ListTicketsQuery } from '@domain/ports/TicketRepository';
import { PaginatedResult } from '../dto/pagination';
import { Ticket } from '@domain/entities/ticket';

export class ListTickets {
  constructor(private readonly repo: TicketRepository) {}

  execute(query: ListTicketsQuery): Promise<PaginatedResult<Ticket>> {
    return this.repo.list({
      page: query.page ?? 1,
      limit: query.limit ?? 25,
      search: query.search,
      status: query.status,
      priority: query.priority,
    });
  }
}
