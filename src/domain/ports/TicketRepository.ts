import { Ticket, TicketStats, TicketStatus, TicketPriority } from '../entities/ticket';
import { PaginatedResult, PaginatedQuery } from '../entities/pagination';

export interface ListTicketsQuery extends PaginatedQuery {
  search?: string;
  // Phase 2: TicketStatus = string (dynamic catalog), so any name is valid here.
  status?: TicketStatus;
  priority?: TicketPriority;
  customerId?: string;            // habilita "Tickets (N)" por cliente
  assigneeId?: string;            // #25 — filtrar por asignado (excluye no-asignados)
  from?: string;                  // #25 — createdAt >= from (ISO date YYYY-MM-DD)
  to?: string;                    // #25 — createdAt <= fin del día de to
  areaId?: string;                // #49 — filtrar por área
  // #85 — when true returns ONLY archived tickets; default (false/absent) excludes them
  archived?: boolean;
  /** fix-be #2 (messaging-inbox-v2 review) — when true, returns ONLY open tickets
   * (resolvedAt IS NULL AND archivedAt IS NULL), same semantics as
   * `countOpenByClientIds`. Additive/optional: absent/false leaves every existing
   * caller's behavior untouched (any status, subject to the other filters).
   *
   * MUTUALLY EXCLUSIVE with `closedOnly` — never set both `true`. The adapters
   * do NOT agree on what that combination means (Prisma: last-write-wins,
   * `closedOnly`'s where-assignment runs after `openOnly`'s, so closed wins;
   * InMemory: sequential narrowing, so the result is always empty). `ListTickets`
   * (the only place these two flags are meant to be read together) enforces
   * this fail-fast via `TicketListFilterConflictError` — do NOT rely on either
   * repo implementation to resolve the conflict for you. */
  openOnly?: boolean;
  /** states-be (messaging-inbox-v2 F1.5, spec #2) — when true, returns ONLY closed
   * tickets (resolvedAt IS NOT NULL AND archivedAt IS NULL). Mirror of `openOnly`.
   * Additive/optional: absent/false leaves every existing caller untouched.
   *
   * MUTUALLY EXCLUSIVE with `openOnly` — see the note on that field. */
  closedOnly?: boolean;
}

export interface CreateTicketData {
  subject: string;
  description: string;
  customerId?: string | null;     // FK (replaces clientId texto libre)
  // FK to Contract. Required on the create FLOW (route + CreateTicket use case
  // enforce it), but OPTIONAL on the port type so the many direct repo.create()
  // test fixtures and old tickets (nullable in DB) keep working. The use case is
  // the enforcement seam when its customer/contract lookups are wired.
  contractId?: string | null;
  priority?: TicketPriority;
  assigneeId?: string | null;
  reporterId?: string | null;     // #48 — estampado desde la sesion (req.user.id) en el route
  areaId?: string | null;         // #49 — required in route, optional in port (like reporterId)
}

export interface UpdateTicketData {
  subject?: string;
  description?: string;
  // Phase 2: status is the catalog name string (not a DB id).
  // The repository resolves name→id at the persistence boundary.
  status?: TicketStatus;
  priority?: TicketPriority;
  assigneeId?: string | null;
  areaId?: string | null;         // #49 — null = clear area; undefined = don't touch
}

export interface TicketRepository {
  list(query: ListTicketsQuery): Promise<PaginatedResult<Ticket>>;
  getById(id: string): Promise<Ticket | null>;
  /**
   * customer-portal-api (fix wave C3) — lookup by the public display number
   * (`sequenceNumber`, unique). The portal DTOs deliberately never expose the
   * internal UUID, so the portal detail endpoint resolves by this number; the
   * caller (GetPortalTicket) enforces client ownership on the result.
   */
  getBySequenceNumber(sequenceNumber: number): Promise<Ticket | null>;
  getStats(): Promise<TicketStats>;
  create(data: CreateTicketData): Promise<Ticket>;
  update(id: string, data: UpdateTicketData): Promise<Ticket | null>;
  /**
   * Persist the ticket as closed using the canonical catalog status NAME
   * resolved by the caller (CloseTicket). The repo never hardcodes 'closed' —
   * it writes exactly the name it is given (catalog-aware, casing-safe).
   */
  close(id: string, statusName: string): Promise<Ticket | null>;
  /**
   * #85 — Archive a ticket (must be closed first; validated by ArchiveTicket use case).
   * Sets archivedAt to now. Returns null if not found.
   */
  archive(id: string): Promise<Ticket | null>;
  /**
   * #85 — Hard-delete a ticket. Returns true if deleted, false if not found.
   */
  delete(id: string): Promise<boolean>;
  /**
   * Portfolio (Fase 3) — count OPEN tickets per client for a set of clientIds,
   * in a SINGLE aggregated query (no N+1). "Open" = resolvedAt IS NULL AND archivedAt IS NULL.
   * Returns a Map keyed by clientId; clientIds with zero open tickets MAY be absent (caller defaults to 0).
   */
  countOpenByClientIds(clientIds: string[]): Promise<Map<string, number>>;
  /**
   * states-be (messaging-inbox-v2 F1.5, spec #2) — mirror of `countOpenByClientIds`
   * for CLOSED tickets per client, in a SINGLE aggregated query (no N+1).
   * "Closed" = resolvedAt IS NOT NULL AND archivedAt IS NULL. Returns a Map keyed
   * by clientId; clientIds with zero closed tickets MAY be absent (caller defaults to 0).
   */
  countClosedByClientIds(clientIds: string[]): Promise<Map<string, number>>;
  /**
   * v2.B (portal-ticket-messaging) — estampa el cursor de lectura del lado dado
   * al timestamp `at` explícito. Efecto secundario de "abrir el hilo" (GET de
   * mensajes del lado correspondiente) — NUNCA se llama al escribir un mensaje
   * propio. No-op silencioso si el ticket no existe (mismo criterio idempotente
   * que `delete`).
   *
   * F5 (fix wave) — `at` es SIEMPRE explícito, el repo NUNCA calcula `now()`
   * internamente: listar y marcar-leído son dos operaciones separadas, y un
   * mensaje nuevo puede aterrizar en la ventana entre ambas. El caller (el use
   * case que hizo el `list`) DEBE pasar el `createdAt` del ÚLTIMO mensaje
   * efectivamente listado — nunca el reloj de pared del momento del mark — así
   * el cursor nunca avanza más allá de lo que el caller realmente mostró en ESA
   * respuesta. Ver `ListPortalTicketMessages` / `ListTicketComments`.
   */
  markMessagesRead(ticketId: string, side: 'client' | 'staff', at: Date): Promise<void>;
}
