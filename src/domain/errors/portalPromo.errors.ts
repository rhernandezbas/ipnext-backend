import { DomainError } from './index';

/** Admin CRUD — la promo referenciada por `id` no existe. */
export class PortalPromoNotFoundError extends DomainError {
  constructor(id: string) {
    super(`PortalPromo with id ${id} not found`, 'PORTAL_PROMO_NOT_FOUND');
    this.name = 'PortalPromoNotFoundError';
  }
}

/** Admin CRUD — payload inválido (create/update). */
export class PortalPromoValidationError extends DomainError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'PortalPromoValidationError';
  }
}
