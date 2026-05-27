import { TicketStatusRepository } from '@domain/ports/TicketStatusRepository';
import { TicketStatusCatalog } from '@domain/entities/ticketStatusCatalog';
import { TicketStatusNotFoundError } from '@domain/errors/tickets';

export class GetTicketStatus {
  constructor(private readonly repo: TicketStatusRepository) {}
  async execute(id: string): Promise<TicketStatusCatalog> {
    const item = await this.repo.getById(id);
    if (!item) throw new TicketStatusNotFoundError(id);
    return item;
  }
}
