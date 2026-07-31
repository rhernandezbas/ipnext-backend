import { TicketRepository } from '@domain/ports/TicketRepository';
import { TicketCommentRepository } from '@domain/ports/TicketCommentRepository';
import { TicketNotFoundError } from '@domain/errors';

/**
 * GetTicketUnreadCount — portal-ticket-messaging (v2.B), lado ADMIN.
 *
 * spec "No leídos por lado" — mitad staff del indicador. Deliberadamente NO se
 * agregó a `TicketDto`/`GetTicket`/`ListTickets`: esos tres tienen 14+ call
 * sites en features no relacionadas (external API, messaging inbox, etc.) —
 * inyectarles un `TicketCommentRepository` nuevo solo para esto hubiera sido
 * blast radius injustificado para un contador. Este use case + su propia ruta
 * (`GET /api/tickets/:ticketId/messages/unread-count`) es la superficie
 * aditiva, de bajo riesgo, que el FE de Prominense puede consumir para el
 * indicador — ver el reporte de la tarea para el detalle de esta decisión de
 * scoping.
 */
export class GetTicketUnreadCount {
  constructor(
    private readonly tickets: TicketRepository,
    private readonly comments: TicketCommentRepository,
  ) {}

  async execute(ticketId: string): Promise<number> {
    const ticket = await this.tickets.getById(ticketId);
    if (!ticket) throw new TicketNotFoundError(ticketId);

    const since = ticket.staffMessagesReadAt ? new Date(ticket.staffMessagesReadAt) : null;
    return this.comments.countUnread(ticketId, 'staff', since);
  }
}
