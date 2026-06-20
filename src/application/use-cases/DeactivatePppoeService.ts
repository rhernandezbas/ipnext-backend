import { PppoeService } from '@domain/entities/pppoeService';
import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { PppoeRouterGateway } from '@domain/ports/PppoeRouterGateway';
import { NasRepository } from '@domain/ports/NasRepository';
import { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';
import { NasNotFoundError, PppoeServiceNotFoundError } from '@domain/errors/pppoe';
import { toNasTarget } from './nasTarget';

/**
 * Baja SOFT: deshabilita el usuario y marca `status='disabled'`. No borra la fila
 * (inventario conservado, reactivable). Plano de control primero, luego DB.
 *
 * El destino se RUTEA por `nas.type`:
 *   - `mikrotik_radius` → `orchestrator.suspend` (el API del router RouterOS 7.x CUELGA;
 *     el RADIUS es la fuente de verdad).
 *   - resto (`mikrotik_api`, …) → `router.updateSecret({disabled:true})` (`/ppp secret`), como siempre.
 */
export class DeactivatePppoeService {
  constructor(
    private readonly repo: PppoeServiceRepository,
    private readonly router: PppoeRouterGateway,
    private readonly nasRepo: NasRepository,
    private readonly orchestrator: RadiusOrchestratorGateway,
  ) {}

  async execute(id: string): Promise<PppoeService> {
    const s = await this.repo.findById(id);
    if (!s) throw new PppoeServiceNotFoundError(id);
    const nas = await this.nasRepo.findNasServerById(s.nasId);
    if (!nas) throw new NasNotFoundError(s.nasId);

    if (nas.type === 'mikrotik_radius') {
      await this.orchestrator.suspend(s.username);
    } else {
      await this.router.updateSecret(toNasTarget(nas), s.username, { disabled: true });
    }

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
