import { TicketRepository } from '@domain/ports/TicketRepository';
import { Ticket } from '@domain/entities/ticket';

export class GetTicket {
  constructor(private readonly repo: TicketRepository) {}

  execute(id: string): Promise<Ticket | null> {
    return this.repo.getById(id);
  }
}
