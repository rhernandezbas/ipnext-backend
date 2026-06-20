import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { PppoeServiceNotFoundError } from '@domain/errors/pppoe';

export interface PppoeCredentials {
  username: string;
  password: string;
}

/**
 * GetPppoeCredentials — la superficie DEDICADA y permission-gated para revelar la clave PPPoE.
 *
 * Espeja el patrón de las credenciales de TV (GetTvCredentials): el `PppoeServiceDto` NUNCA expone
 * `password` (frontera de seguridad); la clave SOLO sale por este use case, detrás de `pppoe.manage`.
 * La password vive EN la entidad `PppoeService` (verdad técnica del router), así que basta leerla.
 */
export class GetPppoeCredentials {
  constructor(private readonly repo: PppoeServiceRepository) {}

  async execute(pppoeId: string): Promise<PppoeCredentials> {
    const pppoe = await this.repo.findById(pppoeId);
    if (!pppoe) throw new PppoeServiceNotFoundError(pppoeId);
    return { username: pppoe.username, password: pppoe.password };
  }
}
