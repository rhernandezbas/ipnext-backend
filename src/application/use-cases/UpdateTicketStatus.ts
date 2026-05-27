import { TicketRepository } from '@domain/ports/TicketRepository';
import { Ticket, TicketStatus } from '@domain/entities/ticket';

export class UpdateTicketStatus {
  constructor(private readonly repo: TicketRepository) {}

  execute(id: string, status: TicketStatus): Promise<Ticket | null> {
    return this.repo.update(id, { status });
  }
}
