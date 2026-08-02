import type { TicketRepository } from '@domain/ports/TicketRepository';
import type { TicketAreaCatalogRepository } from '@domain/ports/TicketAreaCatalogRepository';
import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { PortalPromoRepository } from '@domain/ports/PortalPromoRepository';
import type { PortalPromoResponseRepository } from '@domain/ports/PortalPromoResponseRepository';
import type { SegmentMembershipChecker } from '@domain/ports/CustomerRepository';
import { PORTAL_TICKET_SUBJECT_MAX_LEN, DEFAULT_PORTAL_TICKET_AREA_NAME } from './CreatePortalTicket';
import { resolvePortalTicketContract } from './resolvePortalTicketContract';
import { isPortalPromoEligibleNow } from './portalPromoEligibility';

export interface InterestInPortalPromoInput {
  contractId?: string | null;
}

export interface InterestInPortalPromoResult {
  ticketNumber: number;
  /** true = se creó un ticket nuevo (201); false = idempotente, ticket YA existente (200). */
  created: boolean;
}

/**
 * InterestInPortalPromo — portal-promos, `POST /api/portal/promos/:id/interest`.
 *
 * Abre un `Ticket` del cliente reusando la MISMA regla de contrato que
 * `CreatePortalTicket` (`resolvePortalTicketContract`, extraída para este
 * change exactamente para no divergir), con el área `ticketAreaId` de la
 * promo (o la default del config si es null) y un asunto derivado del título.
 *
 * IDEMPOTENTE: `@@unique([promoId, clientId])` es la red REAL (protege contra
 * una carrera de dos requests concurrentes); el chequeo previo
 * (`findByPromoAndClient`) es la ruta RÁPIDA del caso común (doble click,
 * doble submit) — devuelve el `ticketNumber` YA existente sin tocar
 * `TicketRepository` de nuevo.
 *
 * Devuelve `null` cuando la promo no existe, no está vigente para el cliente
 * (borrador/archivada/fuera de ventana/otro segmento), o el cliente YA la
 * había DESCARTADO (`dismissed` — una vez descartada, deja de ser accionable,
 * mismo criterio "ya respondió" que oculta la promo de la lista/detalle) — la
 * ruta responde 404 en los tres casos, sin distinguir cuál.
 *
 * Puede lanzar `PortalContractRequiredError`/`PortalContractNotFoundError`
 * (ver `resolvePortalTicketContract`) — la ruta las mapea igual que
 * `POST /api/portal/tickets`.
 */
export class InterestInPortalPromo {
  constructor(
    private readonly promos: Pick<PortalPromoRepository, 'findById'>,
    private readonly responses: Pick<PortalPromoResponseRepository, 'findByPromoAndClient' | 'create'>,
    private readonly segmentChecker: Pick<SegmentMembershipChecker, 'clientMatchesSegment'>,
    private readonly tickets: Pick<TicketRepository, 'create' | 'getById'>,
    private readonly areas: Pick<TicketAreaCatalogRepository, 'getById' | 'getByName' | 'list'>,
    private readonly customers: Pick<CustomerRepository, 'listContracts'>,
    private readonly defaultAreaName: string = DEFAULT_PORTAL_TICKET_AREA_NAME,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(
    clientId: string,
    promoId: string,
    input: InterestInPortalPromoInput,
  ): Promise<InterestInPortalPromoResult | null> {
    const promo = await this.promos.findById(promoId);
    if (!promo) return null;

    const existing = await this.responses.findByPromoAndClient(promoId, clientId);
    if (existing) {
      if (existing.kind !== 'interested' || !existing.ticketId) return null; // dismissed, o dato inconsistente
      const ticket = await this.tickets.getById(existing.ticketId);
      if (!ticket) return null;
      return { ticketNumber: ticket.sequenceNumber, created: false };
    }

    if (!isPortalPromoEligibleNow(promo, this.clock())) return null;
    const matches = await this.segmentChecker.clientMatchesSegment(clientId, promo.segment);
    if (!matches) return null;

    const requestedContractId = input.contractId?.trim() || null;
    const contract = await resolvePortalTicketContract(this.customers, clientId, requestedContractId);

    const areaId = await this.resolveAreaId(promo.ticketAreaId);
    const subject = `Me interesa: ${promo.title}`.slice(0, PORTAL_TICKET_SUBJECT_MAX_LEN);
    const description = `El cliente expresó interés en la promoción "${promo.title}" desde la app.`;

    const ticket = await this.tickets.create({
      subject,
      description,
      customerId: clientId,
      areaId,
      contractId: contract?.id ?? null,
    });

    const response = await this.responses.create({
      promoId,
      clientId,
      kind: 'interested',
      ticketId: ticket.id,
    });

    if (response.ticketId === ticket.id) {
      return { ticketNumber: ticket.sequenceNumber, created: true };
    }
    // Carrera perdida (ver docblock): otra request ganó la constraint única.
    // Reportamos el ticket GANADOR, nunca el que este request acaba de crear.
    const winningTicket = response.ticketId ? await this.tickets.getById(response.ticketId) : null;
    if (!winningTicket) return null;
    return { ticketNumber: winningTicket.sequenceNumber, created: false };
  }

  private async resolveAreaId(promoAreaId: string | null): Promise<string | null> {
    if (promoAreaId) {
      const area = await this.areas.getById(promoAreaId);
      if (area) return area.id;
    }
    const configured = await this.areas.getByName(this.defaultAreaName);
    if (configured) return configured.id;
    const all = await this.areas.list();
    return all[0]?.id ?? null;
  }
}
