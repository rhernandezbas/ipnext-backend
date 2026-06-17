import { PppoeService } from '@domain/entities/pppoeService';
import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { PppoeRouterGateway } from '@domain/ports/PppoeRouterGateway';
import { NasRepository } from '@domain/ports/NasRepository';
import { NasNotFoundError, PppoeServiceNotFoundError } from '@domain/errors/pppoe';
import { toNasTarget } from './nasTarget';

/**
 * Baja SOFT: deshabilita el `/ppp secret` en el router (`disabled=yes`) y marca `status='disabled'`.
 * No borra la fila (inventario conservado, reactivable). Router primero, luego DB.
 */
export class DeactivatePppoeService {
  constructor(
    private readonly repo: PppoeServiceRepository,
    private readonly router: PppoeRouterGateway,
    private readonly nasRepo: NasRepository,
  ) {}

  async execute(id: string): Promise<PppoeService> {
    const s = await this.repo.findById(id);
    if (!s) throw new PppoeServiceNotFoundError(id);
    const nas = await this.nasRepo.findNasServerById(s.nasId);
    if (!nas) throw new NasNotFoundError(s.nasId);

    await this.router.updateSecret(toNasTarget(nas), s.username, { disabled: true });

    return this.repo.upsertByUsername({
      username: s.username,
      password: s.password,
      profile: s.profile,
      remoteAddress: s.remoteAddress,
      status: 'disabled',
      nasId: s.nasId,
      contractId: s.contractId,
    });
  }
}
