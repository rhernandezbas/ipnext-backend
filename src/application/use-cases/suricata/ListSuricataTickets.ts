import type { SuricataTicketRepository } from '@domain/ports/SuricataTicketRepository';
import type { SuricataVerdictRepository } from '@domain/ports/SuricataVerdictRepository';
import type { SuricataAreaRepository } from '@domain/ports/SuricataAreaRepository';
import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import { deriveSuricataBotState } from '@domain/entities/suricataBotState';
import type {
  ListSuricataTicketsFiltersDto,
  ListSuricataTicketsResultDto,
  SuricataTicketListItemDto,
} from '@application/dto/suricata.dto';

export interface ListSuricataTicketsInput {
  filters?: ListSuricataTicketsFiltersDto;
  page?: number;
  limit?: number;
}

const DEFAULT_LIMIT = 20;

/**
 * suricata-tickets-mirror (Phase F, task F.1, spec UI-1, design D3/D13) —
 * filterable ticket list for the panel:
 *
 *   1. Fetch tickets matching the base (repo-level) filters — status,
 *      priority, area, assignee.
 *   2. Batch-load each matched ticket's LATEST verdict (ONE query, never
 *      N+1) and derive its `botState` (D9's stale rule included).
 *   3. `botState` is a DERIVED filter — applied here, after step 2, since
 *      the repository alone cannot see it.
 *   4. Sort by `lastMessageAt` descending (most recently active first,
 *      nulls last) and paginate in-memory over the already-narrowed set.
 */
export class ListSuricataTickets {
  constructor(
    private readonly tickets: SuricataTicketRepository,
    private readonly verdicts: SuricataVerdictRepository,
    private readonly areas: SuricataAreaRepository,
    private readonly users: RbacUserRepository,
  ) {}

  async execute(input: ListSuricataTicketsInput = {}): Promise<ListSuricataTicketsResultDto> {
    const { botState: botStateFilter, ...baseFilters } = input.filters ?? {};
    const rows = await this.tickets.list(baseFilters);

    const verdictByTicketId = await this.verdicts.latestByTicketIds(rows.map((r) => r.id));
    const [areaRows, userRows] = await Promise.all([this.areas.list(), this.users.list()]);
    const areaNameById = new Map(areaRows.map((a) => [a.id, a.name]));
    const userNameById = new Map(userRows.map((u) => [u.id, u.name]));

    let derived = rows.map((ticket) => ({
      ticket,
      botState: deriveSuricataBotState(ticket, verdictByTicketId.get(ticket.id) ?? null),
    }));

    if (botStateFilter !== undefined) {
      derived = derived.filter((d) => d.botState === botStateFilter);
    }

    derived.sort((a, b) => (b.ticket.lastMessageAt ?? '').localeCompare(a.ticket.lastMessageAt ?? ''));

    const page = input.page && input.page > 0 ? Math.floor(input.page) : 1;
    const limit = input.limit && input.limit > 0 ? Math.floor(input.limit) : DEFAULT_LIMIT;
    const total = derived.length;
    const start = (page - 1) * limit;
    const pageItems = derived.slice(start, start + limit);

    const data: SuricataTicketListItemDto[] = pageItems.map(({ ticket, botState }) => ({
      id: ticket.id,
      externalId: ticket.externalId,
      subject: ticket.subject,
      status: ticket.status,
      priority: ticket.priority,
      areaId: ticket.areaId,
      areaName: ticket.areaId ? areaNameById.get(ticket.areaId) ?? null : null,
      botState,
      assigneeId: ticket.assigneeId,
      assigneeName: ticket.assigneeId ? userNameById.get(ticket.assigneeId) ?? null : null,
      lastMessageAt: ticket.lastMessageAt,
      syncedAt: ticket.syncedAt,
    }));

    return { data, total, page, limit };
  }
}
