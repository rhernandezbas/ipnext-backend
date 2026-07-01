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

/**
 * fix-wave-2 (CRITICAL): el rename de un PPPoE requiere NAS de tipo `radius_orchestrator`.
 * El flujo es SOLO-RADIUS (usa orchestrator.createUser / deleteUser siempre). Un NAS
 * `mikrotik_api` u otro tipo no pasa por el radius-orchestrator → rechazar antes de tocar
 * el plano de control, para no crear fantasmas en el RADIUS ni inconsistencias en el espejo.
 * Code → HTTP: PPPOE_RENAME_NAS_NOT_SUPPORTED → 422.
 */
export class PppoeRenameNasNotSupportedError extends DomainError {
  constructor(public readonly nasType: string) {
    super(
      `El rename de PPPoE requiere un NAS de tipo 'radius_orchestrator' — tipo '${nasType}' no está soportado`,
      'PPPOE_RENAME_NAS_NOT_SUPPORTED',
    );
    this.name = 'PppoeRenameNasNotSupportedError';
  }
}

/**
 * pppoe-move-nas (REQ-MOVE-3): move entre tipos de NAS MIXTOS (radius_orchestrator ↔ legacy).
 * El flujo radius reasigna IP + Framed-IP central; el legacy copia el secret por API del router.
 * No hay puente coherente entre ambos → se rechaza ANTES de tocar nada.
 * Code → HTTP: PPPOE_MOVE_MIXED_NAS_TYPES → 409.
 */
export class PppoeMoveMixedNasTypesError extends DomainError {
  constructor(
    public readonly fromType: string,
    public readonly toType: string,
  ) {
    super(
      `Move de PPPoE entre tipos de NAS mixtos no soportado: origen '${fromType}' ↔ destino '${toType}' (radius↔legacy)`,
      'PPPOE_MOVE_MIXED_NAS_TYPES',
    );
    this.name = 'PppoeMoveMixedNasTypesError';
  }
}

/**
 * pppoe-move-nas: el servicio está 'terminated' (baja HARD: usuario borrado del RADIUS, IP liberada).
 * No hay nada que mover — la fila es una lápida. Code → HTTP: PPPOE_TERMINATED → 409.
 */
export class PppoeServiceTerminatedError extends DomainError {
  constructor(public readonly id: string) {
    super(`El PPPoE ${id} está dado de baja (terminated) — no se puede mover`, 'PPPOE_TERMINATED');
    this.name = 'PppoeServiceTerminatedError';
  }
}

/**
 * pppoe-pool-ip: la IP provista no es un IPv4 válido (formato inválido).
 * Code → HTTP: INVALID_IP_FORMAT → 422.
 */
export class InvalidIpFormatError extends DomainError {
  constructor(public readonly ip: string) {
    super(`IP '${ip}' no es un IPv4 válido`, 'INVALID_IP_FORMAT');
    this.name = 'InvalidIpFormatError';
  }
}

/**
 * pppoe-pool-ip: la IP a pinear ya está asignada a OTRO usuario en el RADIUS (radreply Framed-IP).
 * Code → HTTP: IP_ALREADY_TAKEN → 409.
 */
export class IpAlreadyTakenError extends DomainError {
  constructor(public readonly ip: string) {
    super(`La IP ${ip} ya está asignada a otro usuario`, 'IP_ALREADY_TAKEN');
    this.name = 'IpAlreadyTakenError';
  }
}

/**
 * pppoe-pool-ip: se intentó despinear (unpin) un servicio en un NAS que NO está en modo pool
 * (poolName nulo). Sin pool de respaldo el cliente quedaría sin IP → el unpin es inválido.
 * Code → HTTP: NAS_NO_POOL → 409.
 */
export class NasNoPoolError extends DomainError {
  constructor(public readonly nasId: string) {
    super(`El NAS ${nasId} no está en modo pool (sin poolName) — no hay pool al que volver`, 'NAS_NO_POOL');
    this.name = 'NasNoPoolError';
  }
}

/**
 * pppoe-pool-ip (Decisión 3): se intentó marcar un NAS en modo pool con un pool que no existe
 * en el `radippool` o que no tiene IPs libres. Aceptarlo dejaría a las altas nuevas sin IP.
 * Code → HTTP: RADIUS_POOL_EMPTY → 409.
 */
export class RadiusPoolEmptyError extends DomainError {
  constructor(public readonly poolName: string) {
    super(
      `El pool '${poolName}' no existe o no tiene IPs libres en el RADIUS — no se puede marcar el NAS en modo pool`,
      'RADIUS_POOL_EMPTY',
    );
    this.name = 'RadiusPoolEmptyError';
  }
}
