import type { TicketRepository } from '@domain/ports/TicketRepository';
import type { PortalTicketDetailDto } from '@application/dto/portal/portalTicket.dto';

/**
 * GetPortalTicket — customer-portal-api (Fase 5, task 5.1 + fix wave C3).
 *
 * C3: el detalle se resuelve por `sequenceNumber` — el `number` publico que SI
 * viaja en los DTOs de lista/creacion. Los DTOs del portal no exponen el UUID
 * interno a proposito, asi que resolver por UUID dejaba este caso de uso
 * inalcanzable para la app.
 *
 * portal-self-service spec "Ticket ajeno por id": pertenencia verificada acá —
 * `null` cubre TANTO "no existe" COMO "es de otro cliente" (la ruta responde el
 * MISMO 404 en los dos casos, sin distinguir). El detalle NUNCA incluye
 * comentarios (ver nota en portalTicket.dto.ts).
 */
export class GetPortalTicket {
  constructor(private readonly tickets: TicketRepository) {}

  async execute(clientId: string, ticketNumber: number): Promise<PortalTicketDetailDto | null> {
    const ticket = await this.tickets.getBySequenceNumber(ticketNumber);
    if (!ticket || ticket.customerId !== clientId) {
      return null;
    }
    return {
      number: ticket.sequenceNumber,
      subject: ticket.subject,
      description: ticket.description,
      status: ticket.status,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
    };
  }
}
