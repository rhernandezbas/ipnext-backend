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

/**
 * #47k — the customer has no Gigared account bound (getAccountByInternalId → 404).
 * Distinct from GIGARED_NOT_FOUND so the cancel flow can surface a TV-specific message
 * ("este cliente no tiene TV vinculada") → router 404 TV_NOT_LINKED.
 */
export class TvNotLinkedError extends DomainError {
  constructor(public readonly customerId: string) {
    super(`Customer ${customerId} has no Gigared TV account linked`, 'TV_NOT_LINKED');
    this.name = 'TvNotLinkedError';
  }
}

/**
 * #65 — a caller-provided password fails the Gigared CUA policy ([a-z0-9], 8..64).
 * Distinct so the change-password route maps it to 400 VALIDATION_ERROR (not a 422 upstream
 * rejection): the request never leaves our boundary.
 */
export class GigaredInvalidPasswordError extends DomainError {
  constructor(message = 'La contraseña solo puede contener letras minúsculas y números (8 a 64)') {
    super(message, 'VALIDATION_ERROR');
    this.name = 'GigaredInvalidPasswordError';
  }
}

/**
 * #70 — register: the password is generated server-side from the customer's grClienteId
 * (deterministic `ip{grClienteId}` padded, #65). A customer with no grClienteId has no source
 * for that password, so the register cannot proceed → router 422 GR_CLIENT_ID_REQUIRED. No
 * hidden random fallback (that generator was removed in the #70 first pass).
 */
export class GrClientIdRequiredError extends DomainError {
  constructor(
    public readonly customerId: string,
    message = 'El cliente no tiene ID de Gestión Real — no se puede generar la contraseña',
  ) {
    super(message, 'GR_CLIENT_ID_REQUIRED');
    this.name = 'GrClientIdRequiredError';
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
 * #115 — register: the target contract exists and belongs to the client but its grContratoId is
 * null or produces a non-CUA password → the deterministic TV identity cannot be derived.
 * Router 422 GR_CONTRACT_ID_REQUIRED. Gigared is never touched.
 */
export class GrContractIdRequiredError extends DomainError {
  constructor(
    public readonly contractId: string,
    message = 'El contrato no tiene ID de Gestión Real — no se puede generar la identidad de TV',
  ) {
    super(message, 'GR_CONTRACT_ID_REQUIRED');
    this.name = 'GrContractIdRequiredError';
  }
}

/**
 * #109 — register: the CIC pool (unregistered accounts) is empty, so automatic CIC assignment
 * cannot proceed → router 422 NO_CIC_AVAILABLE. The FE shows a modal "no hay CIC de TV disponible".
 */
export class NoCicAvailableError extends DomainError {
  constructor(message = 'No hay CIC de TV disponible en el pool — contactá al administrador') {
    super(message, 'NO_CIC_AVAILABLE');
    this.name = 'NoCicAvailableError';
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
