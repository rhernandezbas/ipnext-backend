import { PppoeService } from '@domain/entities/pppoeService';
import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { PppoeRouterGateway } from '@domain/ports/PppoeRouterGateway';
import { NasRepository } from '@domain/ports/NasRepository';
import { NasNotFoundError, PppoeServiceNotFoundError } from '@domain/errors/pppoe';
import { toNasTarget } from './nasTarget';

export interface MovePppoeServiceInput {
  id: string;
  nasId: string; // router destino
}

/**
 * Mueve un PPPoE a otro router: crea el secret en el DESTINO primero (si falla, aborta sin tocar
 * nada), luego lo da de baja en el ORIGEN, y por último actualiza `nasId` en la DB.
 */
export class MovePppoeServiceToRouter {
  constructor(
    private readonly repo: PppoeServiceRepository,
    private readonly router: PppoeRouterGateway,
    private readonly nasRepo: NasRepository,
  ) {}

  async execute(input: MovePppoeServiceInput): Promise<PppoeService> {
    const s = await this.repo.findById(input.id);
    if (!s) throw new PppoeServiceNotFoundError(input.id);
    if (input.nasId === s.nasId) return s; // ya está en ese router (no-op)

    const destino = await this.nasRepo.findNasServerById(input.nasId);
    if (!destino) throw new NasNotFoundError(input.nasId);
    // pppoe-preprovision: nasId null (pendiente de instalación) → sin origen que dar de baja.
    const origen = s.nasId !== null ? await this.nasRepo.findNasServerById(s.nasId) : null;

    // crear en destino primero (si falla → throw, nada cambió)
    await this.router.createSecret(toNasTarget(destino), {
      username: s.username,
      password: s.password,
      profile: s.profile,
      remoteAddress: s.remoteAddress,
      disabled: s.status === 'disabled',
    });
    // baja en origen (si el NAS origen ya no existe en el inventario, se omite)
    if (origen) {
      await this.router.removeSecret(toNasTarget(origen), s.username);
    }

    return this.repo.upsertByUsername({
      username: s.username,
      password: s.password,
      profile: s.profile,
      remoteAddress: s.remoteAddress,
      status: s.status,
      nasId: input.nasId,
      contractId: s.contractId,
    });
  }
}
