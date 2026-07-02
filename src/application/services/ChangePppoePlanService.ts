/**
 * ChangePppoePlanService — APPLICATION layer service (pppoe-search-bulk-plan).
 *
 * Extracted from UpdatePppoeService to share the plan-change logic between
 * UpdatePppoeService (PATCH /api/pppoe/:id) and BulkChangePppoePlan.
 *
 * Responsibility: given a resolved PppoeService + NasServer + new profile,
 *   1. Route by nas.type: radius_orchestrator → orchestrator.changePlan (CoA, applyInSession:true)
 *      | other → router.updateSecret
 *   2. Upsert the DB (profile updated)
 *   3. Record a best-effort 'modified' event if the service has a contractId
 *      (actor + reason + notes "oldPlan → newPlan")
 *
 * DIP: depends only on ports from @domain/ports. No Prisma / Express / axios imports.
 */
import { PppoeService } from '@domain/entities/pppoeService';
import { NasServer } from '@domain/entities/nas';
import { routesViaOrchestrator } from '@domain/entities/nas';
import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { PppoeRouterGateway } from '@domain/ports/PppoeRouterGateway';
import { NasRepository } from '@domain/ports/NasRepository';
import { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';
import { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import { ContractServiceEventRepository } from '@domain/ports/ContractServiceEventRepository';
import { toNasTarget } from '@application/use-cases/nasTarget';

export interface ChangePlanInput {
  /** The resolved PPPoE service entity (already fetched by the caller). */
  service: PppoeService;
  /** The resolved NasServer entity for this service (already fetched by the caller). */
  nas: NasServer;
  /** The new plan/profile code (e.g. 'IP-50M'). Must be non-null and non-empty. */
  profile: string;
  /** Optional reason for the history event. */
  reason?: string | null;
  actorId?: string | null;
  actorName?: string;
}

/**
 * APPLICATION service: shared plan-change logic used by both UpdatePppoeService
 * and BulkChangePppoePlan.
 *
 * Does NOT resolve the NAS or the service — the caller must pass them in (already fetched).
 * This keeps the method fast and allows the bulk use case to resolve them in batch.
 */
export class ChangePppoePlanService {
  constructor(
    private readonly repo: PppoeServiceRepository,
    private readonly router: PppoeRouterGateway,
    private readonly nasRepo: NasRepository,
    private readonly orchestrator: RadiusOrchestratorGateway,
    private readonly catalogRepo: ServiceCatalogRepository,
    private readonly eventRepo: ContractServiceEventRepository,
  ) {}

  /**
   * Apply a plan change to a PPPoE service.
   *
   * Throws if the plano de control call fails (so the bulk use case can catch per-item).
   * The history event is best-effort: a failure there does NOT throw.
   */
  async changePlan(input: ChangePlanInput): Promise<void> {
    const { service, nas, profile, reason, actorId, actorName } = input;

    // 1. Apply on the control plane (same logic as UpdatePppoeService):
    //    - radius_orchestrator: changePlan with CoA (applyInSession:true — no disconnect)
    //    - other (mikrotik_api, etc.): updateSecret via RouterOS
    if (routesViaOrchestrator(nas.type)) {
      await this.orchestrator.changePlan(service.username, profile, { applyInSession: true });
    } else {
      await this.router.updateSecret(toNasTarget(nas), service.username, { profile });
    }

    // 2. Upsert the DB after the control plane confirmed.
    await this.repo.upsertByUsername({
      username:      service.username,
      password:      service.password,
      profile,
      remoteAddress: service.remoteAddress,
      status:        service.status,
      nasId:         service.nasId,
      contractId:    service.contractId,
    });

    // 3. Record 'modified' event best-effort (same as UpdatePppoeService).
    if (service.contractId != null) {
      try {
        const catalog = await this.catalogRepo.getByName('INTERNET');
        if (catalog) {
          await this.eventRepo.record({
            contractId:       service.contractId,
            serviceCatalogId: catalog.id,
            eventType:        'modified',
            reason:           reason ?? null,
            actorId:          actorId ?? null,
            actorName:        actorName ?? '',
            notes:            `${service.profile ?? '—'} → ${profile}`,
          });
        }
      } catch (err) {
        // Best-effort: a history event failure NEVER reverts a successful plan change.
        console.warn('[ChangePppoePlanService] Failed to record modified event (best-effort):', err);
      }
    }
  }
}
