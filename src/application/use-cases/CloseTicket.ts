import { TicketRepository } from '@domain/ports/TicketRepository';
import { TicketStatusRepository } from '@domain/ports/TicketStatusRepository';
import { Ticket } from '@domain/entities/ticket';
import { NoClosableStatusError } from '@domain/errors/tickets';

// Known "closed-like" slugs, tried in order. getByName is case-insensitive,
// so 'closed' matches 'Closed'/'CLOSED' and 'cerrado' matches 'Cerrado'.
const CLOSED_SLUGS = ['closed', 'cerrado'] as const;

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
