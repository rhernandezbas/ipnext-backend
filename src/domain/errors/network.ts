import { DomainError } from './index';

/**
 * IP-allocator domain errors (ip-allocator feature).
 * Codes = wire contract; el errorHandler los mapea a un HTTP status fijo:
 *   NO_POOL_FOR_NAS_TYPE → 404   NO_FREE_IP → 422
 */

/** El NAS no tiene ningún pool del `type` (cgnat|public) pedido. No hay de dónde asignar. */
export class NoPoolForNasTypeError extends DomainError {
  constructor(
    public readonly nasId: string,
    public readonly type: string,
  ) {
    super(`El NAS ${nasId} no tiene un pool '${type}'`, 'NO_POOL_FOR_NAS_TYPE');
    this.name = 'NoPoolForNasTypeError';
  }
}

/** El pool existe pero está agotado: cada IP usable ya está asignada en el router. */
export class NoFreeIpError extends DomainError {
  constructor(public readonly poolId: string) {
    super(`No quedan IPs libres en el pool ${poolId}`, 'NO_FREE_IP');
    this.name = 'NoFreeIpError';
  }
}
