import type { TicketRepository } from '@domain/ports/TicketRepository';
import type { PortalTicketListItemDto } from '@application/dto/portal/portalTicket.dto';
import type { PaginatedQuery, PaginatedResult } from '@application/dto/pagination';

/**
 * ListPortalTickets — customer-portal-api (Fase 5, task 5.1).
 *
 * portal-self-service spec "Mis tickets — ver y crear": `clientId` SIEMPRE del
 * token, pasado como `customerId` al `TicketRepository.list` existente (mismo
 * port que consume `ListTickets` admin) — anti-IDOR: ningun otro filtro llega
 * desde afuera.
 */
export class ListPortalTickets {
  constructor(private readonly tickets: TicketRepository) {}

  async execute(clientId: string, query: PaginatedQuery): Promise<PaginatedResult<PortalTicketListItemDto>> {
    const result = await this.tickets.list({
      page: query.page,
      limit: query.limit,
      customerId: clientId,
    });
    return {
      data: result.data.map(toPortalTicketListItemDto),
      total: result.total,
      page: result.page,
      limit: result.limit,
    };
  }
}

function toPortalTicketListItemDto(ticket: {
  sequenceNumber: number;
  subject: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}): PortalTicketListItemDto {
  return {
    number: ticket.sequenceNumber,
    subject: ticket.subject,
    status: ticket.status,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}
