import { DomainError } from './index';

export class SessionNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Session with id ${id} not found`, 'SESSION_NOT_FOUND');
    this.name = 'SessionNotFoundError';
  }
}
