import { TicketCommentRepository } from '@domain/ports/TicketCommentRepository';
import { TicketRepository } from '@domain/ports/TicketRepository';
import { TicketComment } from '@domain/entities/ticketComment';
import { TicketNotFoundError } from '@domain/errors';

export class ListTicketComments {
  constructor(
    private readonly repo: TicketCommentRepository,
    private readonly ticketRepo: TicketRepository,
  ) {}

  async execute(ticketId: string): Promise<TicketComment[]> {
    const ticket = await this.ticketRepo.getById(ticketId);
    if (!ticket) throw new TicketNotFoundError(ticketId);
    return this.repo.listByTicket(ticketId);
  }
}
