import type { TicketRepository } from '@domain/ports/TicketRepository';
import type { TicketAreaCatalogRepository } from '@domain/ports/TicketAreaCatalogRepository';
import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { PortalTicketDetailDto } from '@application/dto/portal/portalTicket.dto';
import {
  PortalTicketValidationError,
  PortalContractRequiredError,
  PortalContractNotFoundError,
  PortalTicketTopicNotFoundError,
} from '@domain/errors/portal.errors';

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
  /**
   * portal-ticket-contract (v2.A) — "para abrir un reclamo debería
   * seleccionar el contrato primero". REQUERIDO cuando el cliente del token
   * tiene ≥1 contrato (ver `PortalContractRequiredError`); ignorado/no
   * exigido cuando el cliente no tiene ninguno.
   */
  contractId?: string | null;
  /**
   * portal-ticket-topic — id de un `TicketAreaCatalog` con `portalVisible =
   * true` (ver `GET /api/portal/ticket-topics`). Ausente / null / '' -> el
   * camino de la opción "Otro / no sé" de la app: comportamiento VIEJO sin
   * cambios (área del config + fallback, ver `resolveAreaId`). Presente pero
   * inexistente O interno (`portalVisible = false`) -> `PortalTicketTopicNotFoundError`
   * — el BE es la autoridad, nunca confía en lo que la app filtró.
   */
  topicId?: string | null;
}

/**
 * CreatePortalTicket — customer-portal-api (Fase 5, task 5.2 + v2.A
 * portal-ticket-contract).
 *
 * portal-self-service spec "Cliente crea un reclamo": crea el `Ticket` asociado
 * al `clientId` del token. Va DIRECTO a `TicketRepository.create` (NO reusa el
 * `CreateTicket` admin use case): ese use case, cuando el wiring de producción
 * le inyecta los lookups de ownership customer+contract, exige `contractId`
 * SIEMPRE (incluso para clientes sin contratos) — un requisito que el portal
 * no puede replicar 1:1 (acá el requisito es CONDICIONAL, ver abajo). El
 * status inicial sale gratis: TODOS los adapters de `TicketRepository.create`
 * (Prisma e in-memory) hardcodean el status 'open' del catálogo.
 *
 * v2.A — contrato del reclamo: el usuario pidió elegir el contrato ANTES de
 * abrir el reclamo. Reglas (mismo espíritu que `CreateTicket` admin, pero
 * status code distinto — ver `PortalContractNotFoundError`):
 *   - Cliente CON ≥1 contrato: `contractId` es REQUERIDO
 *     (`PortalContractRequiredError` si falta/viene vacío).
 *   - El `contractId` recibido DEBE pertenecer al cliente del token —
 *     resuelto reusando `CustomerRepository.listContracts` (mismo port que
 *     `ListPortalPlans`, sin agregar un port nuevo). Ajeno o inexistente ⇒
 *     `PortalContractNotFoundError` — UN SOLO error para los dos casos (la
 *     ruta responde el mismo 404 sin filtrar cuál ocurrió, igual que
 *     `GetPortalTicket`/"Ticket ajeno por id"). Esta validación es la
 *     AUTORIDAD: la app puede filtrar el selector con `/plans`, pero acá se
 *     verifica de nuevo siempre.
 *   - Cliente SIN contratos: se acepta sin `contractId` (igual tiene derecho
 *     a pedir soporte) — el ticket queda con `contractId: null`. Si igual
 *     manda un `contractId` (imposible que sea suyo, porque no tiene
 *     ninguno), también es `PortalContractNotFoundError` — nunca se ignora
 *     un id ajeno en silencio.
 *
 * Área: portal-ticket-topic — el cliente puede ELEGIR un tópico
 * (`topicId`, resuelto contra `TicketAreaCatalogRepository.getPortalVisibleById`,
 * la ÚNICA autoridad: un id inexistente o interno —NOC/GigaRed— tira
 * `PortalTicketTopicNotFoundError`, nunca se ignora en silencio). Sin
 * `topicId` (ausente/null/'', el camino "Otro / no sé" de la app) se resuelve
 * por NOMBRE configurable (constructor param, default
 * `DEFAULT_PORTAL_TICKET_AREA_NAME`) — comportamiento ORIGINAL intacto: si el
 * nombre configurado no existe en el catálogo, cae a la PRIMERA área que
 * devuelva `list()` — jamás crea un área nueva desde el portal (design.md §6).
 */
export class CreatePortalTicket {
  constructor(
    private readonly tickets: TicketRepository,
    private readonly areas: TicketAreaCatalogRepository,
    private readonly customers: Pick<CustomerRepository, 'listContracts'>,
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

    const requestedContractId = input.contractId?.trim() || null;
    const contracts = await this.customers.listContracts(clientId);

    let contract: { id: string; plan: string } | null = null;
    if (contracts.length > 0) {
      // Cliente CON contratos: contractId es REQUERIDO.
      if (!requestedContractId) {
        throw new PortalContractRequiredError();
      }
      const found = contracts.find((c) => c.id === requestedContractId) ?? null;
      if (!found) {
        // Ajeno o inexistente — mismo error para los dos (anti-enumeración).
        throw new PortalContractNotFoundError();
      }
      contract = found;
    } else if (requestedContractId) {
      // Cliente SIN contratos pero mandó un contractId igual: no puede ser
      // suyo (no tiene ninguno) — nunca se ignora en silencio.
      throw new PortalContractNotFoundError();
    }
    // else: sin contratos y sin contractId -> OK, contract queda null.

    // portal-ticket-topic — '' / '   ' se tratan como ausente, mismo criterio
    // que `requestedContractId` arriba.
    const requestedTopicId = input.topicId?.trim() || null;
    const areaId = await this.resolveAreaId(requestedTopicId);

    const ticket = await this.tickets.create({
      subject,
      description,
      customerId: clientId,
      areaId,
      contractId: contract?.id ?? null,
    });

    return {
      number: ticket.sequenceNumber,
      subject: ticket.subject,
      description: ticket.description,
      status: ticket.status,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      contractId: contract?.id ?? null,
      // v2.A — campo legible (Contract.plan), ver doc de PortalTicketDetailDto.
      contractLabel: contract?.plan ?? null,
      // v2.B — un ticket recién creado no tiene mensajes todavía: 0 sin
      // necesidad de consultar el repo de comentarios acá.
      unreadCount: 0,
    };
  }

  private async resolveAreaId(topicId: string | null): Promise<string | null> {
    if (topicId) {
      // portal-ticket-topic — AUTORIDAD: `getPortalVisibleById` devuelve null
      // tanto para un id inexistente como para uno de un área INTERNA
      // (portalVisible=false, p.ej. NOC/GigaRed) — un único error para los
      // dos casos, nunca se distingue cuál pasó (anti-enumeración).
      const topic = await this.areas.getPortalVisibleById(topicId);
      if (!topic) throw new PortalTicketTopicNotFoundError();
      return topic.id;
    }

    // Sin topicId (camino "Otro / no sé" de la app) — comportamiento ORIGINAL.
    const configured = await this.areas.getByName(this.defaultAreaName);
    if (configured) return configured.id;

    // Fallback: la primera área del catálogo (JAMÁS se crea una área nueva
    // desde el portal — design.md §6).
    const all = await this.areas.list();
    return all[0]?.id ?? null;
  }
}
