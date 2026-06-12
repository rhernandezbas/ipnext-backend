import { TicketAreaCatalogRepository } from '@domain/ports/TicketAreaCatalogRepository';
import { TicketAreaCatalog } from '@domain/entities/ticket-area-catalog';
import { TicketAreaNotFoundError } from '@domain/errors/tickets';

export class GetTicketArea {
  constructor(private readonly repo: TicketAreaCatalogRepository) {}
  async execute(id: string): Promise<TicketAreaCatalog> {
    const item = await this.repo.getById(id);
    if (!item) throw new TicketAreaNotFoundError(id);
    return item;
  }
}
