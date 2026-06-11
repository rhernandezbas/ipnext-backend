import { TicketCommentRepository } from '@domain/ports/TicketCommentRepository';
import { TicketComment } from '@domain/entities/ticketComment';

export class InMemoryTicketCommentRepository implements TicketCommentRepository {
  private readonly store: TicketComment[] = [];

  async listByTicket(ticketId: string): Promise<TicketComment[]> {
    return this.store
      .filter((c) => c.ticketId === ticketId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async create(comment: TicketComment): Promise<TicketComment> {
    this.store.push(comment);
    return comment;
  }
}
