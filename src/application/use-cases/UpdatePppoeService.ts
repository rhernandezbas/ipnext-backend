import { PppoeService } from '@domain/entities/pppoeService';
import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { PppoeRouterGateway, SecretInput } from '@domain/ports/PppoeRouterGateway';
import { NasRepository } from '@domain/ports/NasRepository';
import { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';
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
 * Edita un PPPoE: aplica el cambio en el plano de control PRIMERO, y si responde, confirma en la DB.
 * Si el plano de control falla, la DB no cambia (502, reintentable). Solo se tocan los campos provistos.
 *
 * El destino se RUTEA por `nas.type` (igual que CreatePppoeService):
 *   - `mikrotik_radius` → el orchestrator es la fuente de verdad y el API del router (RouterOS 7.x)
 *     CUELGA. Cada campo provisto va a su endpoint: profile→changePlan, password→changePassword,
 *     remoteAddress→changeFramedIp, status→suspend/reactivate.
 *   - resto (`mikrotik_api`, …) → `router.updateSecret` (RouterOS `/ppp secret`), como siempre.
 */
export class UpdatePppoeService {
  constructor(
    private readonly repo: PppoeServiceRepository,
    private readonly router: PppoeRouterGateway,
    private readonly nasRepo: NasRepository,
    private readonly orchestrator: RadiusOrchestratorGateway,
  ) {}

  async execute(input: UpdatePppoeServiceInput): Promise<PppoeService> {
    const s = await this.repo.findById(input.id);
    if (!s) throw new PppoeServiceNotFoundError(input.id);
    const nas = await this.nasRepo.findNasServerById(s.nasId);
    if (!nas) throw new NasNotFoundError(s.nasId);

    if (nas.type === 'mikrotik_radius') {
      // SÓLO los campos provistos. Un `profile` vacío/null no es un plan RADIUS válido → se omite.
      if (input.profile !== undefined && input.profile) await this.orchestrator.changePlan(s.username, input.profile);
      if (input.password !== undefined) await this.orchestrator.changePassword(s.username, input.password);
      if (input.remoteAddress !== undefined) await this.orchestrator.changeFramedIp(s.username, input.remoteAddress);
      if (input.status !== undefined) {
        if (input.status === 'disabled') await this.orchestrator.suspend(s.username);
        else await this.orchestrator.reactivate(s.username);
      }
    } else {
      const patch: Partial<SecretInput> = {};
      if (input.profile !== undefined) patch.profile = input.profile;
      if (input.password !== undefined) patch.password = input.password;
      if (input.remoteAddress !== undefined) patch.remoteAddress = input.remoteAddress;
      if (input.status !== undefined) patch.disabled = input.status === 'disabled';

      await this.router.updateSecret(toNasTarget(nas), s.username, patch);
    }

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
