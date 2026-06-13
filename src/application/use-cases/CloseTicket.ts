import { TicketRepository } from '@domain/ports/TicketRepository';
import { TicketStatusRepository } from '@domain/ports/TicketStatusRepository';
import { Ticket } from '@domain/entities/ticket';
import { CLOSED_STATUS_SLUGS } from '@domain/entities/ticketStatus';
import { NoClosableStatusError } from '@domain/errors/tickets';

// Known "closed-like" slugs, tried in order. getByName is case-insensitive,
// so 'closed' matches 'Closed'/'CLOSED' and 'cerrado' matches 'Cerrado'.
// Single source of truth shared with ArchiveTicket and the repositories (#84).
const CLOSED_SLUGS = CLOSED_STATUS_SLUGS;

export class CloseTicket {
  constructor(
    private readonly repo: TicketRepository,
    private readonly statusRepo: TicketStatusRepository,
  ) {}

  async execute(id: string): Promise<Ticket | null> {
    // Resolve the closed-like catalog entry (case-insensitive, fallback 'cerrado').
    // We write the catalog's CANONICAL name so casing drift never causes a 500.
    let closedEntry = null;
    for (const slug of CLOSED_SLUGS) {
      closedEntry = await this.statusRepo.getByName(slug);
      if (closedEntry) break;
    }
    if (!closedEntry) throw new NoClosableStatusError();

    return this.repo.close(id, closedEntry.name);
  }
}
