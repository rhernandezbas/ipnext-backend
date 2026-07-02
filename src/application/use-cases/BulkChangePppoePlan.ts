/**
 * BulkChangePppoePlan — APPLICATION use case (pppoe-search-bulk-plan).
 *
 * Changes the plan of N explicitly-selected PPPoE services in bulk.
 * Execution is best-effort, grouped by nasId (serial per router, N routers in parallel),
 * with a configurable throttle between ops on the same router.
 *
 * Pre-flight validations (throw before ANY mutation):
 *   1. dedup ids; if empty → BulkEmptyIdsError (route maps to 422; in practice unreachable via
 *      HTTP — the route's Zod `ids.min(1)` already rejects empty arrays with 422 before the use
 *      case runs. Kept as a dedicated error for direct callers — fix-wave S2.)
 *   2. ids.length > MAX_BULK_IDS → BulkTooLargeError (route maps to 422)
 *   3. PlanRepository.findByCode(profile) → null → PlanNotFoundForBulkError (route maps to 422)
 *
 * Per-item errors (not thrown — captured in failed[]):
 *   - id not found → failed { id, username: '', error: 'PPPOE_NOT_FOUND' }
 *   - id lookup (repo.findById) throws → failed { id, username: '', error: 'PPPOE_LOOKUP_FAILED: ...' }
 *     (fix-wave F1 — a transient DB error resolving ONE row must not abort the whole batch)
 *   - NAS lookup (nasRepo.findNasServerById) throws for a whole nasId group → EVERY item in that
 *     group → failed { id, username, error: 'NAS_LOOKUP_FAILED: ...' }, other groups keep going
 *     (fix-wave F1 — this lookup used to be OUTSIDE any try/catch: a throw here used to reject the
 *     WHOLE execute() call, losing every `ok` already produced by other lanes and leaving the rest
 *     of the batch as zombies. Now it's isolated per-group, best-effort end to end.)
 *   - nasServer resolves to null for the group → failed { id, username, error: 'NAS_NOT_FOUND (...)' }
 *   - changePlan throws (router/orchestrator down) → failed { id, username, error: message }
 *
 * Response (synchronous): { ok: string[], failed: { id, username, error }[] }. `execute()` NEVER
 * rejects because of per-item or per-group failures — only the pre-flight validations above throw.
 *
 * DIP: depends only on domain ports + ChangePppoePlanService. No Prisma / Express / axios.
 */
import type { NasServer } from '@domain/entities/nas';
import type { EnforcedState } from '@domain/entities/pppoeService';
import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { PlanRepository } from '@domain/ports/PlanRepository';
import { NasRepository } from '@domain/ports/NasRepository';
import { ChangePppoePlanService } from '@application/services/ChangePppoePlanService';
import { mapWithConcurrency } from '@application/util/mapWithConcurrency';
import { BulkEmptyIdsError, BulkTooLargeError, PlanNotFoundForBulkError } from '@domain/errors/pppoe-bulk';

export const MAX_BULK_IDS = 200;
const DEFAULT_ROUTER_CONCURRENCY = 16;
const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export interface BulkChangePlanInput {
  /** List of PPPoE service IDs to change. Will be deduplicated. */
  ids: string[];
  /** Target plan/profile code (e.g. 'IP-50M'). Must exist in the Plan catalog. */
  profile: string;
  reason?: string | null;
  actorId?: string | null;
  actorName?: string;
}

export interface BulkChangePlanResultItem {
  id: string;
  username: string;
  error: string;
}

export interface BulkChangePlanResult {
  ok: string[];
  failed: BulkChangePlanResultItem[];
}

export interface BulkChangePppoePlanOptions {
  /** Throttle between ops on the SAME router (ms). Default 300. */
  throttleMs?: number;
  /** How many routers to process in parallel. Default 16. */
  routerConcurrency?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Minimal shape of a PppoeService row needed by the bulk executor. */
interface ServiceRow {
  id: string;
  username: string;
  nasId: string;
  contractId: string | null;
  profile: string | null;
  password: string;
  remoteAddress: string | null;
  status: string;
  enforcedState: EnforcedState;
  callerId: string | null;
  ipMode: 'pool' | 'fixed';
  createdAt: string;
}

/**
 * Bulk plan-change use case (pppoe-search-bulk-plan).
 *
 * Constructor: PppoeServiceRepository, PlanRepository, NasRepository, ChangePppoePlanService, opts?
 * - NasRepository is needed to resolve the NasServer for each item (grouped by nasId — one
 *   lookup per nasId, not per item). Separate from the one injected into ChangePppoePlanService.
 */
export class BulkChangePppoePlan {
  private readonly throttleMs: number;
  private readonly routerConcurrency: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly pppoeRepo: PppoeServiceRepository,
    private readonly planRepo: PlanRepository,
    private readonly nasRepo: NasRepository,
    private readonly changePlanSvc: ChangePppoePlanService,
    opts?: BulkChangePppoePlanOptions,
  ) {
    this.throttleMs        = opts?.throttleMs ?? 300;
    this.routerConcurrency = opts?.routerConcurrency ?? DEFAULT_ROUTER_CONCURRENCY;
    this.sleep             = opts?.sleep ?? defaultSleep;
  }

  async execute(input: BulkChangePlanInput): Promise<BulkChangePlanResult> {
    const { profile, reason, actorId, actorName } = input;

    // ── Pre-flight: dedup + size check ──────────────────────────────────────
    const uniqueIds = [...new Set(input.ids)];

    if (uniqueIds.length === 0) {
      // S2 fix-wave: dedicated error, NOT BulkTooLargeError (whose message misleadingly reads
      // "recibió 0 ids, máximo 200"). In production this is unreachable via HTTP — the route's
      // Zod `ids.min(1)` already returns 422 before the use case runs.
      throw new BulkEmptyIdsError();
    }

    if (uniqueIds.length > MAX_BULK_IDS) {
      throw new BulkTooLargeError(uniqueIds.length, MAX_BULK_IDS);
    }

    // ── Pre-flight: fail-fast plan check (ZERO mutation if plan missing) ────
    const plan = await this.planRepo.findByCode(profile);
    if (!plan) {
      throw new PlanNotFoundForBulkError(profile);
    }

    // ── Resolve rows + group by nasId ────────────────────────────────────────
    const groups = new Map<string, ServiceRow[]>();
    const ok: string[] = [];
    const failed: BulkChangePlanResultItem[] = [];

    for (const id of uniqueIds) {
      // F1 fix-wave: catch PER ITEM. A transient error resolving ONE row (e.g. DB hiccup) must
      // not abort the whole batch — it fails only that item and the rest of the pre-flight loop
      // keeps going.
      let s: ServiceRow | null;
      try {
        s = await this.pppoeRepo.findById(id);
      } catch (err) {
        failed.push({
          id,
          username: '',
          error: `PPPOE_LOOKUP_FAILED: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
      if (!s) {
        failed.push({ id, username: '', error: 'PPPOE_NOT_FOUND' });
        continue;
      }
      const list = groups.get(s.nasId);
      if (list) list.push(s);
      else groups.set(s.nasId, [s]);
    }

    // ── Execute: N routers in parallel, each serial with throttle ────────────
    const routers = [...groups.keys()];

    await mapWithConcurrency(routers, this.routerConcurrency, async (nasId) => {
      const list = groups.get(nasId)!;

      // F1 fix-wave: resolve NasServer once per nasId, but INSIDE a try/catch. This lookup used
      // to live OUTSIDE any try/catch — a throw here (e.g. Prisma down) used to reject the WHOLE
      // mapWithConcurrency call, which propagates out of execute() and rejects the entire bulk:
      // every `ok` already produced by OTHER lanes is lost and this lane's items never get a
      // failed[] entry (zombies). Now: this lane's items all go to failed[], other lanes continue.
      let nasServer: NasServer | null;
      try {
        nasServer = await this.nasRepo.findNasServerById(nasId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        for (const s of list) {
          failed.push({ id: s.id, username: s.username, error: `NAS_LOOKUP_FAILED: ${message}` });
        }
        return;
      }

      for (let i = 0; i < list.length; i++) {
        const s = list[i]!;
        const isLast = i === list.length - 1;
        // S1 fix-wave: only items that actually reach the control plane (nasServer resolved,
        // changePlanSvc.changePlan attempted — success OR failure) count as "touched" for
        // throttle purposes. NAS_NOT_FOUND items never dial out, so they must NOT consume a
        // throttle slot.
        let touchedControlPlane = false;

        try {
          if (!nasServer) {
            failed.push({ id: s.id, username: s.username, error: `NAS_NOT_FOUND (nasId=${nasId})` });
          } else {
            touchedControlPlane = true;
            await this.changePlanSvc.changePlan({
              service: s,
              nas:     nasServer,
              profile,
              reason:    reason ?? null,
              actorId:   actorId ?? null,
              actorName: actorName ?? '',
            });
            ok.push(s.id);
          }
        } catch (err) {
          failed.push({
            id:       s.id,
            username: s.username,
            error:    err instanceof Error ? err.message : String(err),
          });
        }

        // S1 fix-wave: throttle between ops on the SAME router — but never after the LAST item
        // of the lane (nothing left to protect the router from), and never after an item that
        // never touched the control plane (NAS_NOT_FOUND / the lookup-failed lane above, which
        // returns before reaching this loop at all).
        if (!isLast && touchedControlPlane && this.throttleMs > 0) await this.sleep(this.throttleMs);
      }
    });

    return { ok, failed };
  }
}
