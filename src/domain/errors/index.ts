export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class ClientNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Client with id ${id} not found`, 'CLIENT_NOT_FOUND');
    this.name = 'ClientNotFoundError';
  }
}

export class TicketNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Ticket with id ${id} not found`, 'TICKET_NOT_FOUND');
    this.name = 'TicketNotFoundError';
  }
}

export class AuthenticationError extends DomainError {
  constructor(message = 'Authentication failed') {
    super(message, 'AUTHENTICATION_ERROR');
    this.name = 'AuthenticationError';
  }
}

export class AccountLockedError extends DomainError {
  constructor(message = 'Account temporarily locked due to failed login attempts') {
    super(message, 'ACCOUNT_LOCKED');
    this.name = 'AccountLockedError';
  }
}

export class SplynxUnavailableError extends DomainError {
  constructor(message = 'Splynx API is unavailable') {
    super(message, 'SPLYNX_UNAVAILABLE');
    this.name = 'SplynxUnavailableError';
  }
}
