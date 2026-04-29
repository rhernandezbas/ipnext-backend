import { TicketRepository } from '@domain/ports/TicketRepository';
import { TicketStats } from '@domain/entities/ticket';

export class GetTicketStats {
  constructor(private readonly repo: TicketRepository) {}

  execute(): Promise<TicketStats> {
    return this.repo.getStats();
  }
}
