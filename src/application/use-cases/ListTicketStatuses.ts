import { TicketStatusRepository } from '@domain/ports/TicketStatusRepository';
import { TicketStatusCatalog } from '@domain/entities/ticketStatusCatalog';

export class ListTicketStatuses {
  constructor(private readonly repo: TicketStatusRepository) {}
  async execute(): Promise<TicketStatusCatalog[]> {
    return this.repo.list();
  }
}
