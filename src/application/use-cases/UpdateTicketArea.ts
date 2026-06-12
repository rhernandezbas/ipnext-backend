import { TicketAreaCatalogRepository } from '@domain/ports/TicketAreaCatalogRepository';
import { TicketAreaCatalog } from '@domain/entities/ticket-area-catalog';
import { TicketAreaNotFoundError, TicketAreaNameConflictError } from '@domain/errors/tickets';

export class UpdateTicketArea {
  constructor(private readonly repo: TicketAreaCatalogRepository) {}
  async execute(id: string, data: { name?: string; color?: string }): Promise<TicketAreaCatalog> {
    const item = await this.repo.getById(id);
    if (!item) throw new TicketAreaNotFoundError(id);

    if (data.name && data.name.toLowerCase() !== item.name.toLowerCase()) {
      const conflict = await this.repo.getByName(data.name);
      if (conflict && conflict.id !== id) throw new TicketAreaNameConflictError(data.name);
    }

    const updated = await this.repo.update(id, data);
    if (!updated) throw new TicketAreaNotFoundError(id);
    return updated;
  }
}
