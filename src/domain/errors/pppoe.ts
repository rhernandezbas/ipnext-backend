import { DomainError } from './index';

/**
 * PPPoE management domain errors (pppoe-management / Fase B).
 * Codes = wire contract; la ruta los mapea a un HTTP status fijo:
 *   ROUTER_UNREACHABLE → 502   PPPOE_USERNAME_TAKEN → 409   PPPOE_NOT_FOUND → 404
 */

/** El router MikroTik no respondió (timeout / red / auth). El aprovisionamiento no se confirma. */
export class RouterUnreachableError extends DomainError {
  constructor(
    public readonly ipAddress: string,
    message = `No se pudo conectar al router ${ipAddress}`,
  ) {
    super(message, 'ROUTER_UNREACHABLE');
    this.name = 'RouterUnreachableError';
  }
}

/** El `username` PPPoE ya existe (es @unique global: no puede vivir en dos routers). */
export class PppoeUsernameTakenError extends DomainError {
  constructor(public readonly username: string) {
    super(`El PPPoE '${username}' ya existe`, 'PPPOE_USERNAME_TAKEN');
    this.name = 'PppoeUsernameTakenError';
  }
}

/** No existe el PppoeService pedido. */
export class PppoeServiceNotFoundError extends DomainError {
  constructor(public readonly id: string) {
    super(`PppoeService ${id} not found`, 'PPPOE_NOT_FOUND');
    this.name = 'PppoeServiceNotFoundError';
  }
}

/**
 * El PPPoE ya está asociado a OTRO contrato. Asociarlo de nuevo a uno distinto requeriría
 * primero desasociarlo: rechazamos para no robar silenciosamente un PPPoE de su contrato.
 * Re-asociar al MISMO contrato es idempotente (no lanza). Code → HTTP: PPPOE_ALREADY_ASSOCIATED → 409.
 */
export class PppoeAlreadyAssociatedError extends DomainError {
  constructor(
    public readonly pppoeId: string,
    public readonly currentContractId: string,
  ) {
    super(
      `El PPPoE ${pppoeId} ya está asociado al contrato ${currentContractId}`,
      'PPPOE_ALREADY_ASSOCIATED',
    );
    this.name = 'PppoeAlreadyAssociatedError';
  }
}

/**
 * Alta en un NAS RADIUS (`radius_orchestrator`) sin `profile`. Un usuario RADIUS NECESITA su grupo/plan
 * (radusergroup) — no hay default. Code → HTTP: PPPOE_PROFILE_REQUIRED → 422.
 */
export class PppoeProfileRequiredError extends DomainError {
  constructor(public readonly username: string) {
    super(
      `El PPPoE '${username}' va a un NAS RADIUS y requiere un 'profile' (plan/grupo del RADIUS)`,
      'PPPOE_PROFILE_REQUIRED',
    );
    this.name = 'PppoeProfileRequiredError';
  }
}

/**
 * El NAS no soporta la ADOPCIÓN del inventario PPPoE (ingest). Hoy SOLO `radius_orchestrator`
 * expone `GET /users` con passwords vía el orchestrator; el resto (`mikrotik_api`, …) no.
 * Code → HTTP: PPPOE_INGEST_NOT_SUPPORTED → 422.
 */
export class PppoeIngestNotSupportedError extends DomainError {
  constructor(public readonly nasType: string) {
    super(
      `La adopción de inventario PPPoE no está soportada para el tipo de NAS '${nasType}' todavía (solo 'radius_orchestrator')`,
      'PPPOE_INGEST_NOT_SUPPORTED',
    );
    this.name = 'PppoeIngestNotSupportedError';
  }
}

/** No existe el NasServer (router) referenciado por `nasId`. */
export class NasNotFoundError extends DomainError {
  constructor(public readonly id: string) {
    super(`NasServer ${id} not found`, 'NAS_NOT_FOUND');
    this.name = 'NasNotFoundError';
  }
}

/**
 * El radius-orchestrator no respondió (timeout / red / 5xx). El corte por RADIUS no se confirma.
 * Code → HTTP: ORCHESTRATOR_UNREACHABLE → 502 (mismo trato que ROUTER_UNREACHABLE).
 */
export class OrchestratorUnreachableError extends DomainError {
  constructor(
    public readonly target: string,
    message = `No se pudo conectar al radius-orchestrator (${target})`,
  ) {
    super(message, 'ORCHESTRATOR_UNREACHABLE');
    this.name = 'OrchestratorUnreachableError';
  }
}

/**
 * El contrato ya tiene un PPPoE activo (status='enabled'). Asociar un segundo requiere
 * primero desasociar el existente. Code → HTTP: PPPOE_CONTRACT_ALREADY_HAS_SERVICE → 409.
 */
export class PppoeContractAlreadyHasServiceError extends DomainError {
  constructor(
    public readonly contractId: string,
    public readonly existingPppoeId: string,
  ) {
    super(
      `El contrato ${contractId} ya tiene un PPPoE activo (${existingPppoeId}). Desasociá el existente antes de asociar otro.`,
      'PPPOE_CONTRACT_ALREADY_HAS_SERVICE',
    );
    this.name = 'PppoeContractAlreadyHasServiceError';
  }
}

/**
 * El radius-orchestrator RECHAZÓ la petición con un error 4xx (400/403/404/409/422…).
 * Indica que la petición fue inválida o fue deliberadamente denegada — NO es un fallo de red.
 * Code → HTTP: ORCHESTRATOR_REJECTED → se reenvía el `upstreamStatus` (ej. 403, 400, 409).
 * El errorHandler mapea ORCHESTRATOR_REJECTED a 422 como fallback si el upstreamStatus no aplica.
 */
export class OrchestratorRejectedError extends DomainError {
  constructor(
    public readonly upstreamStatus: number,
    public readonly upstreamBody: unknown,
    message?: string,
  ) {
    const detail =
      message ??
      (typeof upstreamBody === 'object' &&
      upstreamBody !== null &&
      'detail' in (upstreamBody as Record<string, unknown>)
        ? String((upstreamBody as Record<string, unknown>).detail)
        : `El orchestrator rechazó la petición con ${upstreamStatus}`);
    super(detail, 'ORCHESTRATOR_REJECTED');
    this.name = 'OrchestratorRejectedError';
  }
}
