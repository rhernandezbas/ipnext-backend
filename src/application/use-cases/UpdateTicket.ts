import { TicketRepository, UpdateTicketData } from '@domain/ports/TicketRepository';
import { Ticket } from '@domain/entities/ticket';

export class UpdateTicket {
  constructor(private readonly repo: TicketRepository) {}

  execute(id: string, data: UpdateTicketData): Promise<Ticket | null> {
    return this.repo.update(id, data);
  }
}
