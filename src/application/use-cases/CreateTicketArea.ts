import { TicketAreaCatalogRepository } from '@domain/ports/TicketAreaCatalogRepository';
import { TicketAreaCatalog } from '@domain/entities/ticket-area-catalog';
import { TicketAreaNameConflictError } from '@domain/errors/tickets';

export class CreateTicketArea {
  constructor(private readonly repo: TicketAreaCatalogRepository) {}
  async execute(data: { name: string }): Promise<TicketAreaCatalog> {
    const existing = await this.repo.getByName(data.name);
    if (existing) throw new TicketAreaNameConflictError(data.name);
    return this.repo.create(data);
  }
}
