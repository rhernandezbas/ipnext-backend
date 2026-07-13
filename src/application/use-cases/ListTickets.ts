import { TicketRepository, ListTicketsQuery } from '@domain/ports/TicketRepository';
import { PaginatedResult } from '../dto/pagination';
import { Ticket } from '@domain/entities/ticket';
import { TicketListFilterConflictError } from '@domain/errors/tickets';

export class ListTickets {
  constructor(private readonly repo: TicketRepository) {}

  // NOTE: must stay `async` (not a bare `Promise`-returning function) — the
  // fail-fast throw below needs to reject the returned promise, not throw
  // synchronously out of a non-async call (which would break every caller's
  // `try { await ... } catch` and any `.rejects.toThrow()` assertion).
  async execute(query: ListTicketsQuery): Promise<PaginatedResult<Ticket>> {
    // adversarial review (F1.5 spec #2, LOW finding) — openOnly/closedOnly are
    // mutually exclusive (see TicketRepository.ts). Fail-fast BEFORE reaching
    // the repo: Prisma resolves both-true via last-write-wins (closed wins)
    // while InMemory narrows sequentially (always empty) — same input, two
    // silently divergent adapters. Unreachable via the only current caller
    // (GetInboxClientContext always sets exactly one), but a future caller
    // must not be able to hit that divergence.
    if (query.openOnly === true && query.closedOnly === true) {
      throw new TicketListFilterConflictError();
    }

    return this.repo.list({
      page: query.page ?? 1,
      limit: query.limit ?? 25,
      search: query.search,
      status: query.status,
      priority: query.priority,
      customerId: query.customerId,
      assigneeId: query.assigneeId, // #28 — el #25 los cableó en ruta y repo,
      from: query.from,             // pero este passthrough los descartaba y el
      to: query.to,                 // filtro nunca llegaba al where.
      areaId: query.areaId,         // #49 — ídem; debe llegar al repo
      archived: query.archived,     // #85 — pasar el flag de archivados
      openOnly: query.openOnly,     // fix-be #2 — "solo abiertos" (aditivo, GetInboxClientContext)
      closedOnly: query.closedOnly, // states-be (F1.5 spec #2) — "solo cerrados", espejo de openOnly
    });
  }
}
