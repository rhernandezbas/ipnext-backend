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
 * pppoe-move-nas fix wave 1 (ajuste 6 / S1.5): la IP ACTUAL del servicio cae en un pool
 * `ipKind='public'` y el move llegó SIN `force: true`. Mover un corporativo con IP pública
 * pagada a CGNAT libera su IP contratada — no puede pasar por accidente: exige decisión
 * explícita del operador. Code → HTTP: PPPOE_MOVE_PUBLIC_IP → 409.
 */
export class PppoeMovePublicIpError extends DomainError {
  constructor(
    public readonly pppoeId: string,
    public readonly currentIp: string,
  ) {
    super(
      `El PPPoE ${pppoeId} tiene una IP PÚBLICA (${currentIp}) — mover a CGNAT la libera. Reintentá con force: true si es una decisión explícita.`,
      'PPPOE_MOVE_PUBLIC_IP',
    );
    this.name = 'PppoeMovePublicIpError';
  }
}

/**
 * pppoe-preprovision (REQ-PRE-4): el PPPoE está PENDIENTE DE INSTALACIÓN (nasId null — la
 * pre-provisión todavía no fue adoptada por ningún NAS). Las operaciones que necesitan un NAS
 * (enforce/corte, PATCH, rename, pin/unpin, baja soft) no aplican hasta la adopción — el move
 * manual (= adopción) y el terminate (baja del RADIUS central) SÍ funcionan.
 * Code → HTTP: PPPOE_PENDING_INSTALL → 409.
 */
export class PppoePendingInstallError extends DomainError {
  constructor(public readonly id: string) {
    super(
      `El PPPoE ${id} está pendiente de instalación (sin NAS) — no operable hasta la adopción`,
      'PPPOE_PENDING_INSTALL',
    );
    this.name = 'PppoePendingInstallError';
  }
}

/**
 * pppoe-preprovision D6.5: se intentó ADOPTAR un pendiente de instalación (nasId null) en un
 * NAS LEGACY (no-radius). Un pendiente vive en el RADIUS central: el flujo legacy copiaría el
 * secret al router SIN IP (ignorando la ipTypePreference) y dejaría el usuario fantasma en el
 * RADIUS central. Guard de bomba latente — hoy no hay NAS legacy en prod.
 * Code → HTTP: PPPOE_PENDING_LEGACY_NAS → 409.
 */
export class PppoePendingLegacyNasError extends DomainError {
  constructor(
    public readonly pppoeId: string,
    public readonly nasType: string,
  ) {
    super(
      `El PPPoE ${pppoeId} está pendiente de instalación (vive en el RADIUS central) — no se puede adoptar en un NAS legacy '${nasType}' (no-radius)`,
      'PPPOE_PENDING_LEGACY_NAS',
    );
    this.name = 'PppoePendingLegacyNasError';
  }
}

/**
 * pppoe-preprovision D7.3: carrera de DOBLE ADOPCIÓN perdida — el update condicional de la
 * adopción (`WHERE nasId IS NULL`) matcheó 0 filas porque OTRO actor (tick del watcher vs
 * adopción manual) adoptó el pendiente PRIMERO. La fila del ganador queda intacta; el RADIUS
 * pudo quedar con NUESTRA Framed-IP (divergencia VISIBLE via evento failed_db reason
 * 'concurrent_adoption_lost_race'; SIN auto-heal — consistente con D6.4).
 * Code → HTTP: PPPOE_CONCURRENT_ADOPTION → 409.
 */
export class PppoeConcurrentAdoptionError extends DomainError {
  constructor(public readonly pppoeId: string) {
    super(
      `El PPPoE ${pppoeId} ya fue adoptado por otro actor durante esta adopción (carrera doble-adopción) — nada se pisó; revisá el evento 'concurrent_adoption_lost_race'`,
      'PPPOE_CONCURRENT_ADOPTION',
    );
    this.name = 'PppoeConcurrentAdoptionError';
  }
}
