import { TicketRepository } from '@domain/ports/TicketRepository';
import { TicketStatusRepository } from '@domain/ports/TicketStatusRepository';
import { Ticket } from '@domain/entities/ticket';
import { TicketNotClosedError } from '@domain/errors/tickets';

// Known "closed-like" slugs — same list as CloseTicket (case-insensitive).
const CLOSED_SLUGS = ['closed', 'cerrado'] as const;

export class ArchiveTicket {
  constructor(
    private readonly repo: TicketRepository,
    private readonly statusRepo: TicketStatusRepository,
  ) {}

  async execute(id: string): Promise<Ticket | null> {
    const ticket = await this.repo.getById(id);
    if (!ticket) return null;

    // Resolve closed-like entries from catalog (same pattern as CloseTicket).
    const closedNames: string[] = [];
    for (const slug of CLOSED_SLUGS) {
      const entry = await this.statusRepo.getByName(slug);
      if (entry) closedNames.push(entry.name.toLowerCase());
    }

    if (!closedNames.includes(ticket.status.toLowerCase())) {
      throw new TicketNotClosedError();
    }

    return this.repo.archive(id);
  }
}
