import { ClosedServiceOrder } from '@domain/entities/iclass-closed-order';
import { ClosedServiceOrderRepository } from '@domain/ports/ClosedServiceOrderRepository';
import { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';

/** Default feature-flag key gating the manual reprocess (DB-backed, default OFF). */
export const REPROCESS_FLAG_KEY = 'iclass-closure-reprocess';
/** Must match IngestClosedServiceOrders' cap so listPending and the runner agree. */
const DEFAULT_MAX_AUDIT_ATTEMPTS = 3;

/**
 * Anything that can re-fire the closure side-effects for an already-mirrored SO.
 * IngestClosedServiceOrders.runClosureSideEffects satisfies this structurally; the
 * runner is side-effect-aware (skips effects already done, marks on success).
 */
export interface ClosureSideEffectRunner {
  runClosureSideEffects(order: ClosedServiceOrder, taskId: string): Promise<void>;
}

export interface ReprocessClosureResult {
  /** Flag was OFF → nothing ran. */
  skipped: boolean;
  /** Mirrors found with at least one pending side-effect. */
  candidates: number;
  /** Mirrors we actually re-ran the side-effects for. */
  processed: number;
  /** Candidates skipped because they have no linked local task. */
  noTask: number;
}

/**
 * Manual reprocess of closure side-effects: re-fires only the effects still
 * pending on already-mirrored SOs, decoupled from the mirror idempotency that
 * blocks the normal loop/reconcile from re-running them. Gated by a DB feature
 * flag (manual, like Reconciliar). Per-SO isolation: one failure never aborts the
 * batch. The runner itself skips already-done effects and respects the audit cap.
 */
export class ReprocessClosureSideEffects {
  private readonly flagKey: string;
  private readonly maxAuditAttempts: number;

  constructor(
    private readonly flags: FeatureFlagRepository,
    private readonly closed: ClosedServiceOrderRepository,
    private readonly runner: ClosureSideEffectRunner,
    opts: { flagKey?: string; maxAuditAttempts?: number } = {},
  ) {
    this.flagKey = opts.flagKey ?? REPROCESS_FLAG_KEY;
    this.maxAuditAttempts = opts.maxAuditAttempts ?? DEFAULT_MAX_AUDIT_ATTEMPTS;
  }

  async execute(): Promise<ReprocessClosureResult> {
    const flag = await this.flags.get(this.flagKey);
    if (!flag?.enabled) return { skipped: true, candidates: 0, processed: 0, noTask: 0 };

    const pending = await this.closed.listPendingSideEffects(this.maxAuditAttempts);
    let processed = 0;
    let noTask = 0;
    for (const p of pending) {
      if (!p.scheduledTaskId) {
        noTask++;
        continue; // no local task to attach the effects to
      }
      const order = await this.closed.getByIclassId(p.iclassId);
      if (!order) continue;
      try {
        await this.runner.runClosureSideEffects(order, p.scheduledTaskId);
        processed++;
      } catch {
        /* per-SO isolation — one failure never aborts the batch */
      }
    }
    return { skipped: false, candidates: pending.length, processed, noTask };
  }
}
