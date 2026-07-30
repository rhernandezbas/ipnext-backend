import { DomainError } from './index';

/**
 * portalAdmin.errors — customer-portal-api (Fase 3, task 3.1).
 *
 * Kept in a file SEPARATE from `portal.errors.ts` (Fase 1/2, self-service portal
 * auth) on purpose: this change is implemented in parallel by two agents sharing
 * the same worktree — `portal.errors.ts` is self-service territory, this file is
 * admin-CRUD territory. Zero overlap, zero merge risk.
 */

/** portal-accounts-admin spec — "DNI ya usado por otra cuenta". */
export class PortalDniAlreadyUsedError extends DomainError {
  constructor(dni: string) {
    super(`El DNI ${dni} ya tiene una cuenta de portal`, 'PORTAL_DNI_ALREADY_USED');
    this.name = 'PortalDniAlreadyUsedError';
  }
}

/** portal-accounts-admin spec — "Cliente ya tiene cuenta" (`PortalAccount.clientId` es único). */
export class PortalAccountAlreadyExistsError extends DomainError {
  constructor(clientId: string) {
    super(`El cliente ${clientId} ya tiene una cuenta de portal`, 'PORTAL_ACCOUNT_ALREADY_EXISTS');
    this.name = 'PortalAccountAlreadyExistsError';
  }
}

/**
 * portal-accounts-admin spec — "Cliente sin documento en el espejo y sin override":
 * ni `customAttributes.documento` ni un `dni` explícito en el request. Jamás se
 * crea una cuenta sin DNI.
 */
export class PortalAccountDniRequiredError extends DomainError {
  constructor() {
    super('El cliente no tiene documento en el espejo — pasá un dni explícito', 'PORTAL_ACCOUNT_DNI_REQUIRED');
    this.name = 'PortalAccountDniRequiredError';
  }
}
