import { PppoeService } from '@domain/entities/pppoeService';
import { NasServer } from '@domain/entities/nas';
import { PppoeServiceRepository, PppoeServiceUpsert } from '@domain/ports/PppoeServiceRepository';
import { NasTarget, PppoeRouterGateway } from '@domain/ports/PppoeRouterGateway';
import { NasRepository } from '@domain/ports/NasRepository';
import { NasNotFoundError, PppoeUsernameTakenError } from '@domain/errors/pppoe';

export interface CreatePppoeServiceInput {
  contractId: string | null;
  username: string;
  password: string;
  profile?: string | null;
  remoteAddress?: string | null;
  nasId: string;
}

/**
 * Crea un PPPoE y aprovisiona el `/ppp secret` en el router, de forma consistente:
 * DB `pending` → `createSecret` en el router → DB `enabled`. Si el router falla, la fila
 * queda `pending` (visible, reintentable) y el error se propaga — nunca un "OK" mentiroso.
 */
export class CreatePppoeService {
  constructor(
    private readonly repo: PppoeServiceRepository,
    private readonly router: PppoeRouterGateway,
    private readonly nasRepo: NasRepository,
  ) {}

  async execute(input: CreatePppoeServiceInput): Promise<PppoeService> {
    // 1. `username` es @unique global (un PPPoE no vive en dos routers)
    const dup = await this.repo.findByUsername(input.username);
    if (dup) throw new PppoeUsernameTakenError(input.username);

    // 2. resolver el router destino
    const nas = await this.nasRepo.findNasServerById(input.nasId);
    if (!nas) throw new NasNotFoundError(input.nasId);

    const base: PppoeServiceUpsert = {
      username: input.username,
      password: input.password,
      profile: input.profile ?? null,
      remoteAddress: input.remoteAddress ?? null,
      nasId: input.nasId,
      contractId: input.contractId ?? null,
    };

    // 3. DB pending → router → DB confirm
    await this.repo.upsertByUsername({ ...base, status: 'pending' });
    await this.router.createSecret(toNasTarget(nas), {
      username: input.username,
      password: input.password,
      profile: input.profile ?? null,
      remoteAddress: input.remoteAddress ?? null,
    });
    return this.repo.upsertByUsername({ ...base, status: 'enabled' });
  }
}

function toNasTarget(nas: NasServer): NasTarget {
  return { ipAddress: nas.ipAddress, apiPort: nas.apiPort ?? 8728 };
}
