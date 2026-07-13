import { DomainError } from './index';

export class TicketStatusUnknownError extends DomainError {
  constructor(name: string) {
    super(`Unknown ticket status: "${name}"`, 'TICKET_STATUS_UNKNOWN');
    this.name = 'TicketStatusUnknownError';
  }
}

export class TicketStatusNotFoundError extends DomainError {
  constructor(id: string) {
    super(`TicketStatus with id ${id} not found`, 'TICKET_STATUS_NOT_FOUND');
    this.name = 'TicketStatusNotFoundError';
  }
}

export class TicketStatusNameConflictError extends DomainError {
  constructor(name: string) {
    super(`A ticket status named "${name}" already exists`, 'TICKET_STATUS_NAME_CONFLICT');
    this.name = 'TicketStatusNameConflictError';
  }
}

export class TicketStatusInUseError extends DomainError {
  constructor(public readonly ticketCount: number) {
    super(`TicketStatus is in use by ${ticketCount} ticket(s)`, 'TICKET_STATUS_IN_USE');
    this.name = 'TicketStatusInUseError';
  }
}

// ─── Ticket Area Catalog errors ──────────────────────────────────────────────

export class TicketAreaNotFoundError extends DomainError {
  constructor(id: string) {
    super(`TicketArea with id ${id} not found`, 'TICKET_AREA_NOT_FOUND');
    this.name = 'TicketAreaNotFoundError';
  }
}

export class TicketAreaNameConflictError extends DomainError {
  constructor(name: string) {
    super(`A ticket area named "${name}" already exists`, 'TICKET_AREA_NAME_CONFLICT');
    this.name = 'TicketAreaNameConflictError';
  }
}

export class TicketAreaInUseError extends DomainError {
  constructor(public readonly ticketCount: number) {
    super(`TicketArea is in use by ${ticketCount} ticket(s)`, 'TICKET_AREA_IN_USE');
    this.name = 'TicketAreaInUseError';
  }
}

export class TicketAreaRequiredError extends DomainError {
  constructor() {
    super('Ticket area is required', 'TICKET_AREA_REQUIRED');
    this.name = 'TicketAreaRequiredError';
  }
}

/**
 * #85 — Thrown by ArchiveTicket when the ticket is not in a closed-like status.
 * Mapped to HTTP 422 — archiving requires closure first.
 */
export class TicketNotClosedError extends DomainError {
  constructor() {
    super('Ticket is not closed', 'TICKET_NOT_CLOSED');
    this.name = 'TicketNotClosedError';
  }
}

/**
 * Thrown by CloseTicket when the editable status catalog has no "closed-like"
 * entry (none of the known CLOSED slugs: 'closed', 'cerrado', case-insensitive).
 * Mapped to HTTP 422 — closing is impossible until a closed status is seeded,
 * but it is a client/config problem, not an internal 500.
 */
export class NoClosableStatusError extends DomainError {
  constructor() {
    super(
      'No closed-like status found in the ticket status catalog',
      'NO_CLOSABLE_STATUS',
    );
    this.name = 'NoClosableStatusError';
  }
}

/**
 * states-be (F1.5 spec #2 adversarial review, LOW finding) — thrown by
 * `ListTickets.execute` when the caller sets `openOnly` AND `closedOnly` both
 * `true`. The two flags are documented as MUTUALLY EXCLUSIVE (see
 * `TicketRepository.ts`), but nothing enforced it: `PrismaTicketRepository`
 * resolves the conflict via last-write-wins (`closedOnly` wins, since its
 * `where` assignment runs after `openOnly`'s) while `InMemoryTicketRepository`
 * narrows sequentially (open AND closed can never both be true, so the result
 * is always empty) — same input, different adapters, silently divergent
 * behavior. Unreachable today (the only caller, `GetInboxClientContext`,
 * always sets exactly one), but fail-fast here closes the seam before a
 * future caller can hit it. Reuses the codebase-wide `'VALIDATION_ERROR'`
 * code (400, already mapped in errorHandler's statusMap).
 */
export class TicketListFilterConflictError extends DomainError {
  constructor() {
    super(
      'ListTickets: openOnly and closedOnly are mutually exclusive; set at most one',
      'VALIDATION_ERROR',
    );
    this.name = 'TicketListFilterConflictError';
  }
}

// ─── #79 SLA timer config error ──────────────────────────────────────────────

/** Raised when the merged SLA config would have dangerMinutes <= warnMinutes. */
export class TicketSlaThresholdOrderError extends DomainError {
  constructor(warnMinutes: number, dangerMinutes: number) {
    super(
      `dangerMinutes (${dangerMinutes}) must be greater than warnMinutes (${warnMinutes})`,
      'TICKET_SLA_THRESHOLD_ORDER',
    );
    this.name = 'TicketSlaThresholdOrderError';
  }
}
