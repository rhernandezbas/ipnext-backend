import { TicketStatusRepository } from '@domain/ports/TicketStatusRepository';
import { TicketStatusNotFoundError, TicketStatusInUseError } from '@domain/errors/tickets';

export class DeleteTicketStatus {
  constructor(private readonly repo: TicketStatusRepository) {}
  async execute(id: string): Promise<void> {
    const item = await this.repo.getById(id);
    if (!item) throw new TicketStatusNotFoundError(id);

    const count = await this.repo.countTicketsUsing(item.name);
    if (count > 0) throw new TicketStatusInUseError(count);

    await this.repo.delete(id);
  }
}
