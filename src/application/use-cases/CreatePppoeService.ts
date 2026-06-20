import { PppoeService } from '@domain/entities/pppoeService';
import { PppoeServiceRepository, PppoeServiceUpsert } from '@domain/ports/PppoeServiceRepository';
import { PppoeRouterGateway } from '@domain/ports/PppoeRouterGateway';
import { NasRepository } from '@domain/ports/NasRepository';
import { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';
import { NasNotFoundError, PppoeUsernameTakenError, PppoeProfileRequiredError } from '@domain/errors/pppoe';
import { toNasTarget } from './nasTarget';

export interface CreatePppoeServiceInput {
  contractId: string | null;
  username: string;
  password: string;
  profile?: string | null;
  remoteAddress?: string | null;
  nasId: string;
}

/**
 * Crea un PPPoE y aprovisiona el plano de control, de forma consistente:
 * DB `pending` → aprovisionamiento → DB `enabled`. Si el aprovisionamiento falla, la fila
 * queda `pending` (visible, reintentable) y el error se propaga — nunca un "OK" mentiroso.
 *
 * El destino se RUTEA por `nas.type`:
 *   - `mikrotik_radius` (NAS migrado a RADIUS) → `orchestrator.createUser` (POST /users:
 *     radcheck + radusergroup + radreply Framed-IP-Address). El `profile` ES el plan/grupo RADIUS.
 *   - resto (`mikrotik_api`, …) → `router.createSecret` (RouterOS `/ppp secret`), como siempre.
 */
export class CreatePppoeService {
  constructor(
    private readonly repo: PppoeServiceRepository,
    private readonly router: PppoeRouterGateway,
    private readonly nasRepo: NasRepository,
    private readonly orchestrator: RadiusOrchestratorGateway,
  ) {}

  async execute(input: CreatePppoeServiceInput): Promise<PppoeService> {
    // 1. `username` es @unique global (un PPPoE no vive en dos routers)
    const dup = await this.repo.findByUsername(input.username);
    if (dup) throw new PppoeUsernameTakenError(input.username);

    // 2. resolver el NAS destino
    const nas = await this.nasRepo.findNasServerById(input.nasId);
    if (!nas) throw new NasNotFoundError(input.nasId);

    const profile = input.profile ?? null;
    const remoteAddress = input.remoteAddress ?? null;
    const isRadius = nas.type === 'mikrotik_radius';

    // 2b. Un usuario RADIUS NECESITA su grupo/plan (radusergroup): sin `profile` no hay alta.
    //     Validar ANTES de tocar la DB → no dejamos filas `pending` huérfanas por un input inválido.
    if (isRadius && !profile) throw new PppoeProfileRequiredError(input.username);

    const base: PppoeServiceUpsert = {
      username: input.username,
      password: input.password,
      profile,
      remoteAddress,
      nasId: input.nasId,
      contractId: input.contractId ?? null,
    };

    // 3. DB pending → aprovisionar (RADIUS o router según el NAS) → DB confirm
    await this.repo.upsertByUsername({ ...base, status: 'pending' });
    if (isRadius) {
      // `profile` está garantizado no-null por la guarda de arriba.
      await this.orchestrator.createUser({
        username: input.username,
        password: input.password,
        plan: profile!,
        framedIp: remoteAddress,
      });
    } else {
      await this.router.createSecret(toNasTarget(nas), {
        username: input.username,
        password: input.password,
        profile,
        remoteAddress,
      });
    }
    return this.repo.upsertByUsername({ ...base, status: 'enabled' });
  }
}
