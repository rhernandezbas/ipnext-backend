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
