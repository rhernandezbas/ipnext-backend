import { DomainError } from './index';

/**
 * La antena airOS no respondió al intento de inspección SSH (offline, timeout,
 * IP no alcanzable, o todas las contraseñas fallaron).
 * Code → HTTP: AIROS_UNREACHABLE → se maneja como best-effort (200 con warning),
 * NO como 502, para no romper el flujo del operador.
 */
export class AirOsUnreachableError extends DomainError {
  constructor(
    public readonly ipAddress: string,
    message = `No se pudo conectar a la antena airOS en ${ipAddress} (offline o contraseña incorrecta)`,
  ) {
    super(message, 'AIROS_UNREACHABLE');
    this.name = 'AirOsUnreachableError';
  }
}
