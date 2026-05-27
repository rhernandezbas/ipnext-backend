import { TicketStatusRepository } from '@domain/ports/TicketStatusRepository';
import { TicketStatusCatalog } from '@domain/entities/ticketStatusCatalog';
import { TicketStatusNotFoundError, TicketStatusNameConflictError } from '@domain/errors/tickets';

export class UpdateTicketStatusCatalog {
  constructor(private readonly repo: TicketStatusRepository) {}
  async execute(id: string, data: { name?: string; color?: string; weight?: number }): Promise<TicketStatusCatalog> {
    const item = await this.repo.getById(id);
    if (!item) throw new TicketStatusNotFoundError(id);

    if (data.name && data.name.toLowerCase() !== item.name.toLowerCase()) {
      const conflict = await this.repo.getByName(data.name);
      if (conflict && conflict.id !== id) throw new TicketStatusNameConflictError(data.name);
    }

    const updated = await this.repo.update(id, data);
    if (!updated) throw new TicketStatusNotFoundError(id);
    return updated;
  }
}
