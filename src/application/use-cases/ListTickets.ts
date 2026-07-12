import { TicketRepository, ListTicketsQuery } from '@domain/ports/TicketRepository';
import { PaginatedResult } from '../dto/pagination';
import { Ticket } from '@domain/entities/ticket';

export class ListTickets {
  constructor(private readonly repo: TicketRepository) {}

  execute(query: ListTicketsQuery): Promise<PaginatedResult<Ticket>> {
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
    });
  }
}
