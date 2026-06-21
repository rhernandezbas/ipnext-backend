import { DomainError } from './index';

/**
 * Thrown when a lat/lng/plusCode value fails range or format validation.
 * Maps to HTTP 422 Unprocessable Entity.
 */
export class InvalidLocationError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_LOCATION');
    this.name = 'InvalidLocationError';
  }
}
