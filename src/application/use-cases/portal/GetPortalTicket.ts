import type { TicketRepository } from '@domain/ports/TicketRepository';
import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { PortalTicketDetailDto } from '@application/dto/portal/portalTicket.dto';

/**
 * GetPortalTicket — customer-portal-api (Fase 5, task 5.1 + fix wave C3 + v2.A
 * portal-ticket-contract).
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
 *
 * v2.A — `contractId`/`contractLabel`: el `Ticket` YA trae `contractId` (FK
 * directa, sin costo extra); `contractLabel` se resuelve reusando
 * `CustomerRepository.listContracts(clientId)` (mismo port narrow que
 * `CreatePortalTicket`, sin agregar un lookup-por-id nuevo) y buscando el
 * contrato dentro de la lista del propio cliente — coherente con el anti-IDOR
 * de este use case (nunca se resuelve un contrato fuera del cliente del
 * token). Si el contrato ya no aparece en esa lista (borrado/dado de baja),
 * cae a `null` en vez de romper el detalle del ticket.
 */
export class GetPortalTicket {
  constructor(
    private readonly tickets: TicketRepository,
    private readonly customers: Pick<CustomerRepository, 'listContracts'>,
  ) {}

  async execute(clientId: string, ticketNumber: number): Promise<PortalTicketDetailDto | null> {
    const ticket = await this.tickets.getBySequenceNumber(ticketNumber);
    if (!ticket || ticket.customerId !== clientId) {
      return null;
    }

    let contractLabel: string | null = null;
    if (ticket.contractId) {
      const contracts = await this.customers.listContracts(clientId);
      contractLabel = contracts.find((c) => c.id === ticket.contractId)?.plan ?? null;
    }

    return {
      number: ticket.sequenceNumber,
      subject: ticket.subject,
      description: ticket.description,
      status: ticket.status,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      contractId: ticket.contractId,
      contractLabel,
    };
  }
}
