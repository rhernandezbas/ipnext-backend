import { DomainError } from './index';

// ── ServiceCatalog ───────────────────────────────────────────────────────────

/** A ServiceCatalog row with the given id does not exist. Maps to 404. */
export class ServiceCatalogNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Service catalog entry ${id} not found`, 'SERVICE_CATALOG_NOT_FOUND');
    this.name = 'ServiceCatalogNotFoundError';
  }
}

/** A ServiceCatalog entry with the same name already exists. Maps to 409. */
export class ServiceCatalogNameConflictError extends DomainError {
  constructor(name: string) {
    super(`A service catalog entry named "${name}" already exists`, 'SERVICE_CATALOG_NAME_CONFLICT');
    this.name = 'ServiceCatalogNameConflictError';
  }
}

/** The catalog entry is referenced by at least one ContractService. Maps to 422. */
export class ServiceCatalogInUseError extends DomainError {
  constructor(public readonly count: number) {
    super(`Service catalog entry is in use by ${count} contract service(s)`, 'SERVICE_IN_USE');
    this.name = 'ServiceCatalogInUseError';
  }
}

/** The OTROS catalog entry cannot be deleted. Maps to 422. */
export class ServiceCatalogProtectedError extends DomainError {
  constructor() {
    super('The OTROS service catalog entry cannot be deleted', 'SERVICE_CATALOG_NON_DELETABLE');
    this.name = 'ServiceCatalogProtectedError';
  }
}

/**
 * The OTROS catalog entry cannot be renamed. Maps to 422.
 * Renaming OTROS would bypass the non-deletable guard (rename OTROS → "X", then a fresh
 * deletable "OTROS" could be created). The protected catch-all name is frozen.
 */
export class ServiceCatalogNonRenameableError extends DomainError {
  constructor() {
    super('The OTROS service catalog entry cannot be renamed', 'SERVICE_CATALOG_NON_RENAMEABLE');
    this.name = 'ServiceCatalogNonRenameableError';
  }
}

/** A contract service was added referencing an inactive catalog entry. Maps to 422. */
export class ServiceCatalogInactiveError extends DomainError {
  constructor(id: string) {
    super(`Service catalog entry ${id} is inactive and cannot be added`, 'SERVICE_CATALOG_INACTIVE');
    this.name = 'ServiceCatalogInactiveError';
  }
}

// ── ContractService ──────────────────────────────────────────────────────────

/** A (contractId, serviceCatalogId) pair already exists. Maps to 409. */
export class ContractServiceDuplicateError extends DomainError {
  constructor() {
    super('This service is already linked to the contract', 'CONTRACT_SERVICE_DUPLICATE');
    this.name = 'ContractServiceDuplicateError';
  }
}

/** A ContractService row with the given id does not exist. Maps to 404. */
export class ContractServiceNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Contract service ${id} not found`, 'CONTRACT_SERVICE_NOT_FOUND');
    this.name = 'ContractServiceNotFoundError';
  }
}

// ── Contract ─────────────────────────────────────────────────────────────────

/** A Contract with the given id does not exist. Maps to 404. */
export class ContractNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Contract ${id} not found`, 'CONTRACT_NOT_FOUND');
    this.name = 'ContractNotFoundError';
  }
}
