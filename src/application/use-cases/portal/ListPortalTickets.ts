import type { TicketRepository } from '@domain/ports/TicketRepository';
import type { TicketCommentRepository } from '@domain/ports/TicketCommentRepository';
import type { Ticket } from '@domain/entities/ticket';
import type { PortalTicketListItemDto } from '@application/dto/portal/portalTicket.dto';
import type { PaginatedQuery, PaginatedResult } from '@application/dto/pagination';

/**
 * ListPortalTickets — customer-portal-api (Fase 5, task 5.1).
 *
 * portal-self-service spec "Mis tickets — ver y crear": `clientId` SIEMPRE del
 * token, pasado como `customerId` al `TicketRepository.list` existente (mismo
 * port que consume `ListTickets` admin) — anti-IDOR: ningun otro filtro llega
 * desde afuera.
 *
 * v2.B (portal-ticket-messaging) — `unreadCount` por ticket ("no leídos" para
 * el badge de la app). Un `countUnread` por ticket (N+1) es aceptable acá: el
 * universo YA está acotado a la página de tickets de UN cliente (`customerId`
 * fijo), nunca al listado admin global (miles de tickets) — por eso `ListTickets`
 * (admin) NO se tocó para esto, ver `GetTicketUnreadCount`.
 *
 * F7 (fix wave) — con el cap GENERAL del portal (100, `parsePagination.ts`),
 * este N+1 podía disparar hasta 100 COUNT por pull-to-refresh. En vez de
 * agregar una query agregada (`group by`) al `TicketCommentRepository` solo
 * para esto, `portal.routes.ts` le pone a ESTA ruta un segundo cap, más bajo
 * (25 — el mismo valor que el default de página), documentado ahí. El límite
 * REAL de este N+1 es entonces "hasta 25 COUNT por request", no 100.
 */
export class ListPortalTickets {
  constructor(
    private readonly tickets: TicketRepository,
    private readonly comments: Pick<TicketCommentRepository, 'countUnread'>,
  ) {}

  async execute(clientId: string, query: PaginatedQuery): Promise<PaginatedResult<PortalTicketListItemDto>> {
    const result = await this.tickets.list({
      page: query.page,
      limit: query.limit,
      customerId: clientId,
    });
    const data = await Promise.all(result.data.map((t) => this.toDto(t)));
    return {
      data,
      total: result.total,
      page: result.page,
      limit: result.limit,
    };
  }

  private async toDto(ticket: Ticket): Promise<PortalTicketListItemDto> {
    const since = ticket.clientMessagesReadAt ? new Date(ticket.clientMessagesReadAt) : null;
    const unreadCount = await this.comments.countUnread(ticket.id, 'client', since);
    return {
      number: ticket.sequenceNumber,
      subject: ticket.subject,
      status: ticket.status,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      unreadCount,
    };
  }
}
