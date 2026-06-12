import { TicketAreaCatalogRepository } from '@domain/ports/TicketAreaCatalogRepository';
import { TicketAreaCatalog } from '@domain/entities/ticket-area-catalog';

export class ListTicketAreas {
  constructor(private readonly repo: TicketAreaCatalogRepository) {}
  async execute(): Promise<TicketAreaCatalog[]> {
    return this.repo.list();
  }
}
