import { PppoeService } from '@domain/entities/pppoeService';
import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { PppoeRouterGateway, SecretInput } from '@domain/ports/PppoeRouterGateway';
import { NasRepository } from '@domain/ports/NasRepository';
import { NasNotFoundError, PppoeServiceNotFoundError } from '@domain/errors/pppoe';
import { toNasTarget } from './nasTarget';

export interface UpdatePppoeServiceInput {
  id: string;
  profile?: string | null;
  password?: string;
  remoteAddress?: string | null;
  status?: string; // 'enabled' | 'disabled'
}

/**
 * Edita un PPPoE: aplica el cambio en el router PRIMERO, y si el router responde, confirma en la DB.
 * Si el router falla, la DB no cambia (502, reintentable). Solo se tocan los campos provistos.
 */
export class UpdatePppoeService {
  constructor(
    private readonly repo: PppoeServiceRepository,
    private readonly router: PppoeRouterGateway,
    private readonly nasRepo: NasRepository,
  ) {}

  async execute(input: UpdatePppoeServiceInput): Promise<PppoeService> {
    const s = await this.repo.findById(input.id);
    if (!s) throw new PppoeServiceNotFoundError(input.id);
    const nas = await this.nasRepo.findNasServerById(s.nasId);
    if (!nas) throw new NasNotFoundError(s.nasId);

    const patch: Partial<SecretInput> = {};
    if (input.profile !== undefined) patch.profile = input.profile;
    if (input.password !== undefined) patch.password = input.password;
    if (input.remoteAddress !== undefined) patch.remoteAddress = input.remoteAddress;
    if (input.status !== undefined) patch.disabled = input.status === 'disabled';

    await this.router.updateSecret(toNasTarget(nas), s.username, patch);

    return this.repo.upsertByUsername({
      username: s.username,
      password: input.password ?? s.password,
      profile: input.profile !== undefined ? input.profile : s.profile,
      remoteAddress: input.remoteAddress !== undefined ? input.remoteAddress : s.remoteAddress,
      status: input.status ?? s.status,
      nasId: s.nasId,
      contractId: s.contractId,
    });
  }
}
