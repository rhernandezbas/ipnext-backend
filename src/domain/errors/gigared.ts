import { DomainError } from './index';

/**
 * Gigared TV integration domain errors (#47).
 *
 * Codes are the FROZEN wire contract — the router maps each to a pinned HTTP status:
 *   GIGARED_NOT_CONFIGURED → 503   GIGARED_UNAVAILABLE → 503
 *   GIGARED_AUTH_FAILED    → 502   GIGARED_NOT_FOUND   → 404
 *   GIGARED_REJECTED       → 422   TV_CATALOG_MISSING  → 422
 */

/** Flag OFF or apiKey empty: the integration is not ready (middleware + adapter guard). */
export class GigaredNotConfiguredError extends DomainError {
  constructor(message = 'Gigared integration is not configured') {
    super(message, 'GIGARED_NOT_CONFIGURED');
    this.name = 'GigaredNotConfiguredError';
  }
}

/**
 * Network failure, 5xx, or 429 retries exhausted.
 * `detail` (#47g) carries the upstream RFC 9457 `detail` so the front-end/audit can show
 * the REAL reason ("CUA timed out") instead of an opaque "service unavailable".
 */
export class GigaredUnavailableError extends DomainError {
  constructor(
    message = 'Gigared API is unavailable',
    public readonly detail?: string,
  ) {
    super(message, 'GIGARED_UNAVAILABLE');
    this.name = 'GigaredUnavailableError';
  }
}

/**
 * 401/403 from Gigared — the API key is missing or invalid.
 * `detail` (#47g) carries the upstream RFC 9457 `detail` for transparency.
 */
export class GigaredAuthError extends DomainError {
  constructor(
    message = 'Gigared API key is invalid',
    public readonly detail?: string,
  ) {
    super(message, 'GIGARED_AUTH_FAILED');
    this.name = 'GigaredAuthError';
  }
}

/** 404 from Gigared — account/CIC does not exist upstream. */
export class GigaredNotFoundError extends DomainError {
  constructor(message = 'Gigared account not found') {
    super(message, 'GIGARED_NOT_FOUND');
    this.name = 'GigaredNotFoundError';
  }
}

/** RFC 9457 4xx rejection — carries the upstream `title`/`detail` for the front-end. */
export class GigaredRejectedError extends DomainError {
  constructor(
    public readonly title: string,
    public readonly detail: string,
  ) {
    super(detail || title, 'GIGARED_REJECTED');
    this.name = 'GigaredRejectedError';
  }
}

/** No active 'TV' entry in the ServiceCatalog — local reconcile cannot proceed. */
export class TvCatalogMissingError extends DomainError {
  constructor(message = "ServiceCatalog has no active 'TV' entry") {
    super(message, 'TV_CATALOG_MISSING');
    this.name = 'TvCatalogMissingError';
  }
}

/**
 * C2 — link by CIC: the partner CIC does not exist upstream (GET /accounts/{cic} → 404).
 * Distinct from GIGARED_NOT_FOUND so the front-end can show a CIC-specific message → router 404.
 */
export class CicNotFoundError extends DomainError {
  constructor(public readonly cic: string) {
    super(`Gigared CIC ${cic} not found`, 'CIC_NOT_FOUND');
    this.name = 'CicNotFoundError';
  }
}

/**
 * C2 — link by CIC: the partner already carries a NON-empty internal_id that belongs to a
 * DIFFERENT customer. Re-binding would silently steal the CIC → router 409 CIC_ALREADY_LINKED.
 */
export class CicAlreadyLinkedError extends DomainError {
  constructor(
    public readonly cic: string,
    public readonly linkedInternalId: string,
  ) {
    super(`Gigared CIC ${cic} is already linked to ${linkedInternalId}`, 'CIC_ALREADY_LINKED');
    this.name = 'CicAlreadyLinkedError';
  }
}
