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
