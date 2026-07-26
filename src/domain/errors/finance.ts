import { DomainError } from './index';

/**
 * finance-growth Fase 1 (fix-wave-3 R10) — thrown when a LOAD-BEARING
 * distributed-lock acquisition stays busy for the whole retry budget.
 * `RearmFinanceReceiptsBackfill` is the ONLY current thrower: it and a
 * concurrent scheduler tick write the SAME `cursor` column (`SyncStateRepository`
 * gotcha — they do NOT touch disjoint columns, only the lock keeps them from
 * racing), so losing this race can silently rewind the backfill cursor —
 * never safe to proceed unlocked. Contrast `ForceFinanceDeltaRun`, whose lock
 * is best-effort (its write is a targeted single-column update, immune to
 * ordering — R2) and therefore proceeds WITHOUT throwing when the lock stays
 * busy, instead of using this error.
 *
 * Mapped to HTTP 503 + a `Retry-After` header (never a bare 500) by
 * `errorHandler` — a lock held by a SIBLING request/tick is a transient,
 * retriable condition, not a bug, and the budget (sized to the MEASURED tick
 * hold, R10) means it clears itself shortly.
 */
export class FinanceSyncLockBusyError extends DomainError {
  constructor(
    public readonly lockKey: string,
    public readonly retryAfterSeconds: number,
  ) {
    super(`Lock "${lockKey}" is busy — retry after ~${retryAfterSeconds}s`, 'FINANCE_SYNC_LOCK_BUSY');
    this.name = 'FinanceSyncLockBusyError';
  }
}
