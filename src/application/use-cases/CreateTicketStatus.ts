import { TicketStatusRepository } from '@domain/ports/TicketStatusRepository';
import { TicketStatusCatalog } from '@domain/entities/ticketStatusCatalog';
import { TicketStatusNameConflictError } from '@domain/errors/tickets';

export class CreateTicketStatus {
  constructor(private readonly repo: TicketStatusRepository) {}
  async execute(data: { name: string; color: string; weight: number }): Promise<TicketStatusCatalog> {
    const existing = await this.repo.getByName(data.name);
    if (existing) throw new TicketStatusNameConflictError(data.name);
    return this.repo.create(data);
  }
}
