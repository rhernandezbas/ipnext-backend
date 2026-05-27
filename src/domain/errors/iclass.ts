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

/**
 * Raised when IClass explicitly rejects the request with business `erros`
 * (e.g. ICLERR_0045 codigoCliente over the char limit). Distinct from
 * IClassUnavailableError: the request reached IClass and was understood but
 * refused — the detail carries the concatenated `code: description` of each error.
 */
export class IClassRejectedError extends DomainError {
  /** Concatenated `code: description` of every IClass error. */
  readonly detail: string;
  constructor(detail: string) {
    super(`IClass rejected the request: ${detail}`, 'ICLASS_REJECTED');
    this.name = 'IClassRejectedError';
    this.detail = detail;
  }
}
