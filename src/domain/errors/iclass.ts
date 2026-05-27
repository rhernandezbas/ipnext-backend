import { DomainError } from './index';

/** Raised when the customer city does not match any IClass node (microárea). */
export class IClassNodeNotFoundError extends DomainError {
  constructor(city: string) {
    super(`No IClass node matches city "${city}"`, 'ICLASS_NODE_NOT_FOUND');
    this.name = 'IClassNodeNotFoundError';
  }
}

/** Raised when the IClass API is unreachable, errors out (5xx) or auth fails after a retry. */
export class IClassUnavailableError extends DomainError {
  constructor(message = 'IClass API is unavailable') {
    super(message, 'ICLASS_UNAVAILABLE');
    this.name = 'IClassUnavailableError';
  }
}
