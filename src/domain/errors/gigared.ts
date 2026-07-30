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
  constructor(
    message = 'Gigared account not found',
    /**
     * FIX WAVE F3 (gigared-tv-cic-reuse) — PROVENANCE del not-found. `true` SÓLO cuando el
     * partner respondió `403 cic-ownership-error` ("el revendedor no posee esta cuenta"): ahí
     * rechazó ANTES de tocar nada, así que es seguro descartar ese CIC y probar otro.
     *
     * ⚠️ Un `GigaredNotFoundError` SIN esta marca NO prueba que no se haya creado nada: también
     * nace de un `424 external-service-error` con detail "no se encontró", y un 424 significa
     * que el partner ACEPTÓ el request y su downstream (el CUA) falló ⇒ estado DESCONOCIDO.
     * Reintentar un `register` ahí puede crear una SEGUNDA cuenta real (doble cobro — es la
     * lección F1 del hardening previo). Por eso el reintento acotado exige esta marca.
     */
    public readonly cicNotOwned = false,
  ) {
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
 * B1 (D-pool) — register: TODOS los CICs del pool `unregistered` traen un `internal_id` no vacío
 * (residuo de un `renewCic` de una baja previa, #72 — el partner rechaza el internal_id vacío, así
 * que el CIC reciclado queda "envenenado" para siempre). Es la causa raíz confirmada del incidente
 * Centeno/Vacherand (engram `gigared/root-cause-cic-envenenado`): el register elegía un CIC AL AZAR
 * sin filtrar, y podía heredar la identidad del dueño viejo. Router 422 TV_POOL_POISONED — misma
 * familia que NO_CIC_AVAILABLE (condición de DATOS, no transitoria: reintentar no ayuda hasta
 * limpiar el pool). NINGÚN write al partner ocurre cuando este error se lanza.
 */
export class TvPoolPoisonedError extends DomainError {
  constructor(
    public readonly poisonedCount: number,
    message = 'El pool de CICs de TV está envenenado — ningún CIC disponible está limpio',
  ) {
    super(message, 'TV_POOL_POISONED');
    this.name = 'TvPoolPoisonedError';
  }
}

/**
 * B1 (D-pool) — register: tras `setInternalId`, el readback `getAccountByInternalId(internalId)`
 * NO resuelve al CIC recién estampado (el `internal_id` append-only ya apuntaba a otro dueño
 * histórico, o el readback 404ea). Cortar ACÁ antes de escribir la fila local a medias — el
 * recovery/probe (D2) completa el retry de forma idempotente. Router 503 TV_IDENTITY_UNVERIFIED
 * (el reintento se auto-completa, a diferencia de TV_POOL_POISONED que es una condición de datos).
 */
export class TvIdentityStampUnverifiedError extends DomainError {
  constructor(
    public readonly cic: string,
    public readonly internalId: string,
    message = 'No se pudo verificar que el CIC estampado resuelve a la identidad esperada',
  ) {
    super(message, 'TV_IDENTITY_UNVERIFIED');
    this.name = 'TvIdentityStampUnverifiedError';
  }
}

/**
 * B2 (D2) — register: el email determinístico (grContratoId + seq) ya está asociado a una cuenta
 * cuyo `internal_id` NO es el mío (una colisión genuina, o un huérfano histórico envenenado —
 * mismo email, `internal_id` de un dueño anterior). El recovery NUNCA auto-toca una cuenta bindeada
 * a otro cliente — `setInternalId` no se llama. Router 409 TV_EMAIL_OWNED_BY_OTHER (distinto de
 * CIC_ALREADY_LINKED, que es por CIC, no por email). El operador resuelve vía link/transfer manual.
 */
export class TvEmailOwnedByOtherError extends DomainError {
  constructor(
    public readonly email: string,
    public readonly ownedByInternalId: string,
    message = 'El email determinístico de TV ya pertenece a otra cuenta',
  ) {
    super(message, 'TV_EMAIL_OWNED_BY_OTHER');
    this.name = 'TvEmailOwnedByOtherError';
  }
}

/**
 * gigared-tv-cic-reuse — el LISTADO del pool `unregistered` falló contra el partner.
 *
 * WHY: hasta el 2026-07-30 esa llamada no estaba protegida, así que un `GigaredNotFoundError`
 * del adapter se propagaba crudo y el operador veía un **404 "Gigared account not found"** al
 * dar de ALTA — un mensaje que le lee como "el cliente no existe". Es una condición
 * TRANSITORIA (el partner no respondió), no de datos → router 503, reintentable.
 */
export class TvPoolUnavailableError extends DomainError {
  constructor(
    public readonly detail?: string,
    message = 'No se pudo consultar el pool de CICs de TV — reintentá en unos segundos',
  ) {
    super(message, 'TV_POOL_UNAVAILABLE');
    this.name = 'TvPoolUnavailableError';
  }
}

/**
 * gigared-tv-cic-reuse — se agotaron los candidatos del reintento acotado: cada CIC probado
 * resultó inservible para el partner (403 `cic-ownership-error` / 404 en el `register`).
 *
 * WHY: el incidente del 2026-07-30 fue exactamente esto sin reintento ni error propio — UN
 * cic corrupto (`'00065470 4'`) era el único candidato y tumbaba el 100% de las altas con un
 * 404 crudo. Es una condición de DATOS (los CICs del pool no sirven), no transitoria → 422.
 */
export class TvNoUsableCicError extends DomainError {
  constructor(
    public readonly attemptedCount: number,
    message = 'Ningún CIC del pool resultó utilizable — contactá al administrador',
  ) {
    super(message, 'TV_NO_USABLE_CIC');
    this.name = 'TvNoUsableCicError';
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

/**
 * service-transfer — el cliente DESTINO de una transferencia ya tiene una cuenta de TV vigente
 * (su internal_id vigente resuelve en el CUA). Transferirle otra crearía un doble vínculo
 * irreversible (el mapping internal_id↔CIC del partner es append-only) → router 409
 * TV_ALREADY_LINKED, sin llamar a setInternalId.
 *
 * Fix wave 2: también cubre (a) el guard A→A (FIX-2: transferirse a sí mismo — el destino YA es
 * el dueño; corre ANTES de tocar el partner, así que el cic todavía no se conoce → cic '') y
 * (b) el cross-check LOCAL del resume (FIX-1: el dueño local vigente es un TERCERO — se pasa
 * SU customerId para que el mensaje diga quién tiene la cuenta hoy).
 */
export class TvAlreadyLinkedError extends DomainError {
  constructor(
    public readonly customerId: string,
    public readonly cic: string,
  ) {
    super(
      cic === ''
        ? `Customer ${customerId} already has a Gigared TV account linked`
        : `Customer ${customerId} already has a Gigared TV account linked (CIC ${cic})`,
      'TV_ALREADY_LINKED',
    );
    this.name = 'TvAlreadyLinkedError';
  }
}
