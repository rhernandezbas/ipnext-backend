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
