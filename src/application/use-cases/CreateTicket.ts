import { TicketRepository, CreateTicketData } from '@domain/ports/TicketRepository';
import { Ticket } from '@domain/entities/ticket';

export class CreateTicket {
  constructor(private readonly repo: TicketRepository) {}

  execute(data: CreateTicketData): Promise<Ticket> {
    return this.repo.create(data);
  }
}
