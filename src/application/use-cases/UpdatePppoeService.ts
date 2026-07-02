import { PppoeService } from '@domain/entities/pppoeService';
import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { PppoeRouterGateway, SecretInput } from '@domain/ports/PppoeRouterGateway';
import { NasRepository } from '@domain/ports/NasRepository';
import { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';
import { NasNotFoundError, PppoeServiceNotFoundError, PppoePendingInstallError } from '@domain/errors/pppoe';
import { routesViaOrchestrator } from '@domain/entities/nas';
import { toNasTarget } from './nasTarget';
import { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import { ContractServiceEventRepository } from '@domain/ports/ContractServiceEventRepository';
// pppoe-search-bulk-plan: extracted shared plan-change logic (Decisión 5, Opción B).
import { ChangePppoePlanService } from '@application/services/ChangePppoePlanService';

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
 *
 * pppoe-search-bulk-plan (Decisión 5, Opción B) — F2 fix-wave:
 *   - Profile change delegates to ChangePppoePlanService ONLY when profile is the SOLE field
 *     being changed (profile-only patch). A combined patch (profile + password/status/
 *     remoteAddress) goes ENTIRELY through the legacy inline path below, unchanged, to preserve
 *     the ORIGINAL atomicity: one single control-plane call per field (Mikrotik combines every
 *     field into ONE `updateSecret`), one upsert at the very end, one event at the very end — if
 *     a later field (e.g. suspend) throws, NOTHING commits, not even the already-applied profile.
 *   - F2 fix: the earlier version delegated profile changes for ANY patch that included profile,
 *     even combined ones. That silently changed atomicity in prod: profile got committed +
 *     evented even if a later field (e.g. suspend) failed, and the Mikrotik path issued TWO
 *     `updateSecret` calls instead of one. Delegation is now profile-only.
 *   - The observable contract of PATCH /api/pppoe/:id is UNCHANGED.
 */
export class UpdatePppoeService {
  /** pppoe-search-bulk-plan: lazily constructed from the same ports (injected via constructor). */
  private readonly changePlanSvc: ChangePppoePlanService | null;

  constructor(
    private readonly repo: PppoeServiceRepository,
    private readonly router: PppoeRouterGateway,
    private readonly nasRepo: NasRepository,
    private readonly orchestrator: RadiusOrchestratorGateway,
    /** pppoe-plan-change-history: optional; keeps back-compat with existing tests/callers that don't pass them. */
    private readonly catalogRepo?: ServiceCatalogRepository,
    private readonly eventRepo?: ContractServiceEventRepository,
  ) {
    // Build the shared ChangePppoePlanService only when the optional repos are available.
    // If they're absent (back-compat callers), fall back to the inline inline logic below.
    this.changePlanSvc = catalogRepo && eventRepo
      ? new ChangePppoePlanService(repo, router, nasRepo, orchestrator, catalogRepo, eventRepo)
      : null;
  }

  async execute(input: UpdatePppoeServiceInput): Promise<PppoeService> {
    const s = await this.repo.findById(input.id);
    if (!s) throw new PppoeServiceNotFoundError(input.id);
    // pppoe-preprovision (REQ-PRE-4): un pendiente de instalación (nasId null) no es editable
    // hasta la adopción — error tipado 409, jamás crash/NasNotFound confuso.
    if (s.nasId === null) throw new PppoePendingInstallError(s.id);
    const nas = await this.nasRepo.findNasServerById(s.nasId);
    if (!nas) throw new NasNotFoundError(s.nasId);

    const profileChanged = input.profile !== undefined && input.profile && input.profile !== s.profile;
    const hasOtherFields =
      input.password !== undefined ||
      input.remoteAddress !== undefined ||
      input.status !== undefined;

    // F2 fix-wave: delegate to ChangePppoePlanService ONLY for a profile-ONLY patch. Combined
    // patches (profile + any of password/remoteAddress/status) fall through to the legacy inline
    // path below, UNCHANGED, so the original atomicity + single-updateSecret-call behavior holds.
    if (profileChanged && this.changePlanSvc && !hasOtherFields) {
      await this.changePlanSvc.changePlan({
        service: s,
        nas,
        profile: input.profile!,
        reason:  input.reason ?? null,
        actorId: input.actorId ?? null,
        actorName: input.actorName ?? '',
      });
      // Profile-only change: ChangePppoePlanService already upserted + evented. Return latest state.
      return (await this.repo.findById(s.id))!;
    }

    // ── Non-profile path — ALSO the path for combined patches (profile + other fields) and for
    // legacy back-compat callers without changePlanSvc (catalogRepo/eventRepo not injected) ──────

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
    // F2 fix-wave: reached in TWO cases now — (a) legacy back-compat callers without changePlanSvc
    // (catalogRepo/eventRepo not injected), and (b) COMBINED patches (profile + password/status/
    // remoteAddress) even when changePlanSvc IS present, since those no longer delegate (profile-only
    // delegation only). Both cases upsert + event here, at the very end — same atomicity as before.
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
