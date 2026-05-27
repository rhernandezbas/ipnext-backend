import { TicketRepository } from '@domain/ports/TicketRepository';
import { Ticket } from '@domain/entities/ticket';

export class CloseTicket {
  constructor(private readonly repo: TicketRepository) {}

  execute(id: string): Promise<Ticket | null> {
    return this.repo.close(id);
  }
}
