import { TicketRepository } from '@domain/ports/TicketRepository';

export class DeleteTicketHard {
  constructor(private readonly repo: TicketRepository) {}

  execute(id: string): Promise<boolean> {
    return this.repo.delete(id);
  }
}
