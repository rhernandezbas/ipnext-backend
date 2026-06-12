import { TicketAreaCatalogRepository } from '@domain/ports/TicketAreaCatalogRepository';
import { TicketAreaNotFoundError, TicketAreaInUseError } from '@domain/errors/tickets';

export class DeleteTicketArea {
  constructor(private readonly repo: TicketAreaCatalogRepository) {}
  async execute(id: string): Promise<void> {
    const item = await this.repo.getById(id);
    if (!item) throw new TicketAreaNotFoundError(id);

    const count = await this.repo.countInUse(id);
    if (count > 0) throw new TicketAreaInUseError(count);

    await this.repo.delete(id);
  }
}
