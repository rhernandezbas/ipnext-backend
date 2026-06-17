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

/** No existe el NasServer (router) referenciado por `nasId`. */
export class NasNotFoundError extends DomainError {
  constructor(public readonly id: string) {
    super(`NasServer ${id} not found`, 'NAS_NOT_FOUND');
    this.name = 'NasNotFoundError';
  }
}
