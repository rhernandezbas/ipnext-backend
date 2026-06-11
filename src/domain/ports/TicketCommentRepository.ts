import { TicketComment } from '../entities/ticketComment';

export interface TicketCommentRepository {
  listByTicket(ticketId: string): Promise<TicketComment[]>;
  create(comment: TicketComment): Promise<TicketComment>;
}
