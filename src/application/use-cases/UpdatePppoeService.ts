import { PppoeService } from '@domain/entities/pppoeService';
import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { PppoeRouterGateway, SecretInput } from '@domain/ports/PppoeRouterGateway';
import { NasRepository } from '@domain/ports/NasRepository';
import { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';
import { NasNotFoundError, PppoeServiceNotFoundError } from '@domain/errors/pppoe';
import { routesViaOrchestrator } from '@domain/entities/nas';
import { toNasTarget } from './nasTarget';
import { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import { ContractServiceEventRepository } from '@domain/ports/ContractServiceEventRepository';

export interface UpdatePppoeServiceInput {
  id: string;
  profile?: string | null;
  password?: string;
  remoteAddress?: string | null;
  status?: string; // 'enabled' | 'disabled'
  // pppoe-plan-change-history: reason + actor threaded from the route handler.
  reason?: string | null;
  actorId?: string | null;
  actorName?: string;
}

/**
 * Edita un PPPoE: aplica el cambio en el plano de control PRIMERO, y si responde, confirma en la DB.
 * Si el plano de control falla, la DB no cambia (502, reintentable). Solo se tocan los campos provistos.
 *
 * El destino se RUTEA por `nas.type` (igual que CreatePppoeService):
 *   - `radius_orchestrator` → el orchestrator es la fuente de verdad y el API del router (RouterOS 7.x)
 *     CUELGA. Cada campo provisto va a su endpoint: profile→changePlan, password→changePassword,
 *     remoteAddress→changeFramedIp, status→suspend/reactivate.
 *   - resto (`mikrotik_api`, …) → `router.updateSecret` (RouterOS `/ppp secret`), como siempre.
 *
 * pppoe-plan-change-history:
 *   - changePlan now passes { applyInSession: true } for CoA (hot update, no disconnect).
 *   - After a successful DB upsert, if `profile` changed and `contractId` is set, records a
 *     best-effort 'modified' event with reason + actor + old→new plan in notes.
 */
export class UpdatePppoeService {
  constructor(
    private readonly repo: PppoeServiceRepository,
    private readonly router: PppoeRouterGateway,
    private readonly nasRepo: NasRepository,
    private readonly orchestrator: RadiusOrchestratorGateway,
    /** pppoe-plan-change-history: optional; keeps back-compat with existing tests/callers that don't pass them. */
    private readonly catalogRepo?: ServiceCatalogRepository,
    private readonly eventRepo?: ContractServiceEventRepository,
  ) {}

  async execute(input: UpdatePppoeServiceInput): Promise<PppoeService> {
    const s = await this.repo.findById(input.id);
    if (!s) throw new PppoeServiceNotFoundError(input.id);
    const nas = await this.nasRepo.findNasServerById(s.nasId);
    if (!nas) throw new NasNotFoundError(s.nasId);

    if (routesViaOrchestrator(nas.type)) {
      // SÓLO los campos provistos. Un `profile` vacío/null no es un plan RADIUS válido → se omite.
      // pppoe-plan-change-history: applyInSession:true → CoA updates the live session's rate;
      // no-op if no session, does NOT drop the session.
      if (input.profile !== undefined && input.profile) await this.orchestrator.changePlan(s.username, input.profile, { applyInSession: true });
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

    const result = await this.repo.upsertByUsername({
      username: s.username,
      password: input.password ?? s.password,
      profile: input.profile !== undefined ? input.profile : s.profile,
      remoteAddress: input.remoteAddress !== undefined ? input.remoteAddress : s.remoteAddress,
      status: input.status ?? s.status,
      nasId: s.nasId,
      contractId: s.contractId,
    });

    // pppoe-plan-change-history: record 'modified' event best-effort when the profile changed.
    const profileChanged = input.profile !== undefined && input.profile && input.profile !== s.profile;
    if (profileChanged && s.contractId != null && this.catalogRepo && this.eventRepo) {
      try {
        const catalog = await this.catalogRepo.getByName('INTERNET');
        if (catalog) {
          await this.eventRepo.record({
            contractId: s.contractId,
            serviceCatalogId: catalog.id,
            eventType: 'modified',
            reason: input.reason ?? null,
            actorId: input.actorId ?? null,
            actorName: input.actorName ?? '',
            notes: `${s.profile ?? '—'} → ${input.profile}`,
          });
        }
      } catch (err) {
        console.warn('[UpdatePppoeService] Failed to record modified event (best-effort):', err);
      }
    }

    return result;
  }
}
