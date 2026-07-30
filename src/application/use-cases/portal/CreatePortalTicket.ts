import type { TicketRepository } from '@domain/ports/TicketRepository';
import type { TicketAreaCatalogRepository } from '@domain/ports/TicketAreaCatalogRepository';
import type { PortalTicketDetailDto } from '@application/dto/portal/portalTicket.dto';
import { PortalTicketValidationError } from '@domain/errors/portal.errors';

/** portal-self-service spec "Payload inválido" — mismos topes que la API externa
 * de tickets (externalV1.routes.ts MAX_SUBJECT_LEN/MAX_DESCRIPTION_LEN). */
export const PORTAL_TICKET_SUBJECT_MAX_LEN = 200;
export const PORTAL_TICKET_DESCRIPTION_MAX_LEN = 5000;

/** design.md §6 default — el nombre configurable real lo inyecta el wiring
 * (Fase 7, `config.ts`-pattern / `PORTAL_TICKET_AREA_NAME`). */
export const DEFAULT_PORTAL_TICKET_AREA_NAME = 'Atención al cliente';

export interface CreatePortalTicketInput {
  subject: string;
  description: string;
}

/**
 * CreatePortalTicket — customer-portal-api (Fase 5, task 5.2).
 *
 * portal-self-service spec "Cliente crea un reclamo": crea el `Ticket` asociado
 * al `clientId` del token (nunca un `contractId` — el payload del portal es
 * `{subject, description}`, sin más). Va DIRECTO a `TicketRepository.create`
 * (NO reusa el `CreateTicket` admin use case): ese use case, cuando el wiring de
 * producción le inyecta los lookups de ownership customer+contract (ver su
 * comentario), exige `contractId` — un requisito que el portal NUNCA puede
 * satisfacer (la app no manda contrato). El status inicial sale gratis: TODOS
 * los adapters de `TicketRepository.create` (Prisma e in-memory) hardcodean el
 * status 'open' del catálogo — el mismo mecanismo que usa el flujo admin, sin
 * que este use case tenga que resolverlo.
 *
 * Área: resuelta por NOMBRE configurable (constructor param, default
 * `DEFAULT_PORTAL_TICKET_AREA_NAME`). Si no existe en el catálogo, cae a la
 * PRIMERA área que devuelva `list()` — jamás crea un área nueva desde el portal
 * (design.md §6).
 */
export class CreatePortalTicket {
  constructor(
    private readonly tickets: TicketRepository,
    private readonly areas: TicketAreaCatalogRepository,
    private readonly defaultAreaName: string = DEFAULT_PORTAL_TICKET_AREA_NAME,
  ) {}

  async execute(clientId: string, input: CreatePortalTicketInput): Promise<PortalTicketDetailDto> {
    const subject = input.subject?.trim() ?? '';
    const description = input.description?.trim() ?? '';

    if (!subject || !description) {
      throw new PortalTicketValidationError('subject y description son requeridos');
    }
    if (subject.length > PORTAL_TICKET_SUBJECT_MAX_LEN) {
      throw new PortalTicketValidationError(`subject supera el máximo de ${PORTAL_TICKET_SUBJECT_MAX_LEN} caracteres`);
    }
    if (description.length > PORTAL_TICKET_DESCRIPTION_MAX_LEN) {
      throw new PortalTicketValidationError(`description supera el máximo de ${PORTAL_TICKET_DESCRIPTION_MAX_LEN} caracteres`);
    }

    const areaId = await this.resolveAreaId();

    const ticket = await this.tickets.create({
      subject,
      description,
      customerId: clientId,
      areaId,
    });

    return {
      number: ticket.sequenceNumber,
      subject: ticket.subject,
      description: ticket.description,
      status: ticket.status,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
    };
  }

  private async resolveAreaId(): Promise<string | null> {
    const configured = await this.areas.getByName(this.defaultAreaName);
    if (configured) return configured.id;

    // Fallback: la primera área del catálogo (JAMÁS se crea una área nueva
    // desde el portal — design.md §6).
    const all = await this.areas.list();
    return all[0]?.id ?? null;
  }
}
