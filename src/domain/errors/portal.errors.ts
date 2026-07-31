import { DomainError } from './index';

export class PortalAccountNotFoundError extends DomainError {
  constructor(id: string) {
    super(`PortalAccount with id ${id} not found`, 'PORTAL_ACCOUNT_NOT_FOUND');
    this.name = 'PortalAccountNotFoundError';
  }
}

/**
 * portal-auth spec — "Password incorrecta" + "Cuenta deshabilitada": DNI inexistente,
 * password incorrecta y cuenta disabled DEBEN devolver el MISMO error público (anti
 * user-enumeration). Nunca inspeccionar `.message` para distinguir el motivo real —
 * la distinción vive solo en logs internos, jamás en la respuesta HTTP.
 */
export class InvalidPortalCredentialsError extends DomainError {
  constructor() {
    super('DNI o contraseña incorrectos', 'INVALID_PORTAL_CREDENTIALS');
    this.name = 'InvalidPortalCredentialsError';
  }
}

/** Refresh token ausente, con formato inválido, revocado o expirado. */
export class InvalidPortalRefreshTokenError extends DomainError {
  constructor() {
    super('Refresh token inválido o expirado', 'INVALID_PORTAL_REFRESH_TOKEN');
    this.name = 'InvalidPortalRefreshTokenError';
  }
}

/**
 * portal-auth spec — "Refresh reusado": un refresh YA rotado se presenta de nuevo.
 * Señal de robo de token — distinto código de InvalidPortalRefreshTokenError porque
 * el caller (RefreshPortalSession) ya revocó TODAS las sesiones de la cuenta antes de
 * tirar este error; el 401 es el mismo, pero el código ayuda a diagnosticar en logs.
 */
export class PortalRefreshTokenReusedError extends DomainError {
  constructor() {
    super('Refresh token reusado — todas las sesiones fueron revocadas', 'PORTAL_REFRESH_TOKEN_REUSED');
    this.name = 'PortalRefreshTokenReusedError';
  }
}

export class InvalidCurrentPortalPasswordError extends DomainError {
  constructor() {
    super('La contraseña actual no es correcta', 'INVALID_CURRENT_PORTAL_PASSWORD');
    this.name = 'InvalidCurrentPortalPasswordError';
  }
}

export class PortalPasswordTooShortError extends DomainError {
  constructor() {
    super('La nueva contraseña debe tener al menos 8 caracteres', 'PORTAL_PASSWORD_TOO_SHORT');
    this.name = 'PortalPasswordTooShortError';
  }
}

/**
 * customer-portal-api (Fase 5, task 5.2) — portal-self-service spec "Payload
 * inválido": falta `subject`/`description`, o exceden los largos máximos. Un
 * único error de validación con el detalle en `message` (el campo puntual lo
 * arma el caller — mirror del patrón de VALIDATION_ERROR ya usado en
 * tickets.routes.ts / externalV1.routes.ts, pero como DomainError tipado para
 * que `CreatePortalTicket` sea testeable sin pasar por la ruta).
 */
export class PortalTicketValidationError extends DomainError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'PortalTicketValidationError';
  }
}

/**
 * portal-ticket-contract (v2.A) — "el usuario pidió: para abrir un reclamo
 * debería seleccionar el contrato primero". Un cliente CON al menos un
 * contrato DEBE elegir uno al crear el reclamo (soporte necesita saber sobre
 * qué servicio es); un cliente SIN contratos queda exento (igual tiene
 * derecho a pedir soporte) — ver `CreatePortalTicket`.
 */
export class PortalContractRequiredError extends DomainError {
  constructor() {
    super('Debés seleccionar un contrato para crear el reclamo', 'CONTRACT_REQUIRED');
    this.name = 'PortalContractRequiredError';
  }
}

/**
 * portal-ticket-contract (v2.A) — el `contractId` recibido no existe O
 * pertenece a OTRO cliente. Un ÚNICO error para los dos casos — mismo
 * criterio anti-enumeración que `GetPortalTicket`/"Ticket ajeno por id": la
 * ruta responde el MISMO 404 sin filtrar cuál de los dos motivos ocurrió. El
 * BE es la autoridad de esta validación: la app puede filtrar el selector con
 * `/api/portal/plans`, pero nunca se confía en el `contractId` que manda.
 */
export class PortalContractNotFoundError extends DomainError {
  constructor() {
    super('Contrato no encontrado', 'CONTRACT_NOT_FOUND');
    this.name = 'PortalContractNotFoundError';
  }
}
