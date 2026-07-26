import { SyncStateRepository } from '@domain/ports/SyncStateRepository';
import { DistributedLock } from '@domain/ports/DistributedLock';

const DELTA_ENTITY = 'finance-receipts-delta';

/**
 * fix-wave-1 F8 — MUST match `FinanceReceiptIngestScheduler`'s `LOCK_KEY`
 * exactly. Kept as a separate literal (not an infra import) to respect the
 * `infrastructure → application` dependency direction — the scheduler is
 * infrastructure, this use case is application. Both sides are commented so a
 * future rename of one doesn't silently desync from the other.
 */
const SCHEDULER_LOCK_KEY = 'finance-receipts-ingest';

/**
 * fix-wave-3 R10 — the docblock below originally sized this budget (16 x
 * 100ms = 1500ms) to the MEASURED GR fetch latency alone (1019-1251ms). But
 * the tick does NOT release the lock when the fetch returns — it holds it
 * through 4 separate `$transaction` calls (receipt/application/item/retención
 * upserts, up to ~100-150 rows each) PLUS N `invoiceTypes.upsertIfAbsent`
 * calls, so the REAL hold is plausibly 2-3s. Bumped to 40 x 100ms = 4000ms —
 * comfortably above the 2-3s estimate, same ~30%+ margin discipline as the
 * fix-wave-2 sizing.
 */
const DEFAULT_MAX_LOCK_ATTEMPTS = 40;
const DEFAULT_RETRY_DELAY_MS = 100;

export interface ForceFinanceDeltaRunResult {
  started: true;
}

export interface ForceFinanceDeltaRunOptions {
  /** Bounded retry budget for the lock — never blocks the endpoint forever. Default 16 (~1.5s total). */
  maxLockAttempts?: number;
  /** Delay between lock retries (ms). Default 100. */
  retryDelayMs?: number;
  /** Injectable delay — tests pass 0. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * finance-growth Fase 1 — `POST /api/finance/growth/sync/run` (design.md
 * "POST /sync/run"). The delta lane ALREADY has absolute priority in the
 * shared budget (Decision 4b) — this only skips the wait for
 * `deltaCheckIntervalMs` by clearing `lastRunAt`, so the NEXT scheduler tick
 * treats it as due. NEVER touches the backfill cursor — the historical
 * lane keeps its own automatic pace, this endpoint is "bring me today's
 * numbers now", not "speed up history".
 *
 * fix-wave-2 R2 (supersedes the fix-wave-1 F8 attempt below): the previous
 * fix kept the read-modify-write of the FULL row (`save({...prior,
 * lastRunAt: null})`) and only widened the lock retry budget to 80ms against
 * a MEASURED tick hold of 1019-1251ms — that covered roughly 5-8% of the
 * race window, i.e. essentially unchanged from the original bug ("the form
 * of the fix, not the effect"). It also fell back to writing WITHOUT the
 * lock when the retry budget ran out.
 *
 * The actual fix is a TARGETED single-column update
 * (`SyncStateRepository.clearLastRunAt`) instead of read-modify-write of the
 * whole row: `lastRunAt` is the ONLY column this endpoint ever needs to
 * touch, and unlike `cursor`/`itemsSynced`/`lastResult`, clearing it to
 * `null` is SAFE (never corrupts data) REGARDLESS of what a concurrent
 * tick's own `save()` does — the race disappears BY CONSTRUCTION, not by
 * winning a lock. The lock is still acquired FIRST (defense in depth, and to
 * keep this write from interleaving weirdly with a tick's OTHER writes to
 * the same row), with a budget sized to the MEASURED hold.
 *
 * fix-wave-4 micro — "safe" above is NOT the same as "both orderings honor
 * the caller's request", and the previous revision of this docblock
 * overstated it ("both final states are valid outcomes"). If the in-flight
 * tick's own `save()` (a FRESH, non-null `lastRunAt`) lands AFTER this
 * endpoint's `clearLastRunAt`, the forced run is silently ABSORBED: no
 * error, `execute()` still resolves, the route still answers 202 — but the
 * delta is no longer "due right away", it goes back to waiting the normal
 * `deltaCheckIntervalMs` (default 5 min) the operator explicitly tried to
 * skip. Nothing is corrupted (data-safety is still true), but the OPERATOR-
 * FACING promise of "runs again immediately" is not honored on that
 * ordering. Accepted trade (favors avoiding a 500 over guaranteeing the
 * forced run always wins the race) — documented honestly here instead of
 * papered over as symmetric.
 *
 * fix-wave-3 R10 (supersedes R2's "never write unlocked" stance for THIS use
 * case specifically): R2's own docblock already proves the lock is NOT
 * load-bearing here — the targeted write is safe in EITHER order against a
 * concurrent tick. R10 measured the lock's budget was sized to GR's fetch
 * latency alone while the tick actually holds the lock through 4
 * `$transaction`s + N upserts (real hold plausibly 2-3s) — causing `POST
 * /sync/run` to 500 on ~10-15% of requests at normal pacing, a customer-
 * visible outage for a condition that was always safe to just proceed
 * through. So: if the lock stays busy for the WHOLE retry budget, this now
 * proceeds WITHOUT it (logging a warning) instead of throwing — best-effort
 * for real, not "best-effort in name, fail-loud in practice". Contrast
 * `RearmFinanceReceiptsBackfill` (R6): its lock IS load-bearing (it and a
 * concurrent tick write the SAME `cursor` column, no construction makes that
 * safe unordered) — it still throws `FinanceSyncLockBusyError`, mapped to
 * 503 + `Retry-After` by the route, never a 500.
 */
export class ForceFinanceDeltaRun {
  constructor(
    private readonly state: SyncStateRepository,
    private readonly lock: Pick<DistributedLock, 'tryAcquire' | 'release'>,
    private readonly opts: ForceFinanceDeltaRunOptions = {},
  ) {}

  async execute(): Promise<ForceFinanceDeltaRunResult> {
    const maxAttempts = this.opts.maxLockAttempts ?? DEFAULT_MAX_LOCK_ATTEMPTS;
    const delayMs = this.opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

    let acquired = false;
    for (let attempt = 0; attempt < maxAttempts && !acquired; attempt++) {
      acquired = await this.lock.tryAcquire(SCHEDULER_LOCK_KEY);
      if (!acquired && attempt < maxAttempts - 1) await sleep(delayMs);
    }

    if (!acquired) {
      // fix-wave-3 R10 — proceed WITHOUT the lock instead of throwing (see
      // the class docblock: the targeted `clearLastRunAt` write is safe in
      // EITHER order against a concurrent tick, so the lock here is
      // defense-in-depth, not load-bearing). A 500 was strictly WORSE than
      // proceeding — this trades a customer-visible outage (measured
      // ~10-15% of requests under normal pacing) for a log line.
      console.warn(
        `[finance-receipts] ForceFinanceDeltaRun: lock "${SCHEDULER_LOCK_KEY}" busy after ${maxAttempts} attempts (~${maxAttempts * delayMs}ms budget) — proceeding WITHOUT it (fix-wave-3 R10: safe, targeted single-column update).`,
      );
    }

    try {
      // Targeted update — never reads/rewrites cursor/lastResult/itemsSynced.
      // A missing row is a silent no-op: the delta is already "due" on its
      // very first tick (bootstrap), nothing to force.
      await this.state.clearLastRunAt(DELTA_ENTITY);
      return { started: true };
    } finally {
      if (acquired) await this.lock.release(SCHEDULER_LOCK_KEY);
    }
  }
}
