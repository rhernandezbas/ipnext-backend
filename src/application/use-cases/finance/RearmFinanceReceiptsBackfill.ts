import { SyncStateRepository } from '@domain/ports/SyncStateRepository';
import { DistributedLock } from '@domain/ports/DistributedLock';
import { FinanceSyncLockBusyError } from '@domain/errors/finance';
import { arYearMonth } from './financeDates';

const BACKFILL_ENTITY = 'finance-receipts-backfill';

/**
 * fix-wave-1 F8 / fix-wave-2 R2 — MUST match `FinanceReceiptIngestScheduler`'s
 * `LOCK_KEY` exactly (same literal used by `ForceFinanceDeltaRun`). Kept as a
 * separate literal (not an infra import) to respect the
 * `infrastructure → application` dependency direction.
 */
const SCHEDULER_LOCK_KEY = 'finance-receipts-ingest';

/**
 * fix-wave-3 R10 — bumped from fix-wave-2's 16x100ms=1500ms (sized to the
 * MEASURED GR fetch latency alone, 1019-1251ms) to 40x100ms=4000ms: the tick
 * holds this SAME lock through 4 `$transaction`s (receipt/application/item/
 * retención upserts) PLUS N `invoiceTypes.upsertIfAbsent` calls AFTER the
 * fetch returns — the real hold is plausibly 2-3s, and unlike
 * `ForceFinanceDeltaRun` this lock IS load-bearing (see the class docblock
 * below), so the fix here is a bigger budget + a proper 503, never a bigger
 * budget alone.
 */
const DEFAULT_MAX_LOCK_ATTEMPTS = 40;
const DEFAULT_RETRY_DELAY_MS = 100;
/** Surfaced in the HTTP `Retry-After` header when the lock stays busy — see `FinanceSyncLockBusyError`. */
const DEFAULT_RETRY_AFTER_SECONDS = 2;

export interface RearmFinanceReceiptsBackfillResult {
  rearmed: true;
  cursor: string;
}

export interface RearmFinanceReceiptsBackfillOptions {
  /** Bounded retry budget for the lock. Default 40 (~4s total — fix-wave-3 R10). */
  maxLockAttempts?: number;
  /** Delay between lock retries (ms). Default 100. */
  retryDelayMs?: number;
  /** Injectable delay — tests pass 0. */
  sleep?: (ms: number) => Promise<void>;
  /** Value surfaced in the HTTP `Retry-After` header when the budget is exhausted. Default 2 (seconds). */
  retryAfterSeconds?: number;
}

/**
 * finance-growth Fase 1 — fix-wave-1 F9. The spec requires the backfill lane
 * to stay a no-op after `done` "hasta que se re-arme", but no re-arm path
 * existed anywhere in the code: `ForceFinanceDeltaRun` only ever touches the
 * DELTA lane, and `SyncGrReceiptsBackfillBatch` treats a persisted
 * `cursor: null` as permanently disarmed — resetting `backfillFloorYearMonth`
 * alone never revives it. This aggravates F3: a backfill that self-disarmed
 * on GR's own HTTP-200 errors had ZERO recovery path via the API.
 *
 * This resets the backfill's SyncState cursor to `"{currentMonth}:0"`, i.e.
 * an explicit restart from "now", walking newest→oldest again exactly like a
 * first-ever boot (design.md Decision 4b) — NOT a resume of wherever it was.
 * Works whether the prior state was fully `done`, mid-month, or absent
 * entirely; `itemsSynced` is preserved (this is a restart of the WALK, not a
 * wipe of the cumulative counter).
 *
 * fix-wave-2 R6 (same race class as F8/R2, closed the same way): this used to
 * write `cursor`/`lastResult` (plus a carried-over `lastRunAt`/`itemsSynced`
 * read from a stale snapshot) with NO lock and NO retry at all. Probed
 * scenario: backfill mid-walk at `2019-06:0`; a tick reads that cursor →
 * spends ~1.2s fetching GR → a re-arm request lands DURING that window and
 * writes `2026-07:0` → the tick's OWN end-of-run write (computed from its
 * now-stale pre-rearm read) overwrites the re-arm's `2026-07:0` back down to
 * `2019-05:0` — the re-arm is LOST silently, after the endpoint already
 * answered `202 {rearmed:true}`.
 *
 * The fix has TWO parts, same criterion as `ForceFinanceDeltaRun` (R2):
 * (1) a TARGETED update (`SyncStateRepository.rearmCursor`) that touches
 * ONLY `cursor`/`lastResult` — it never reads (and therefore never
 * clobbers) `lastRunAt`/`itemsSynced`, regardless of what a concurrent tick
 * does to those columns; (2) acquiring the SAME `finance-receipts-ingest`
 * lock the scheduler's `tick()` holds for its entire run — this is what
 * actually eliminates the reported race: if a tick is already in flight when
 * the re-arm request arrives, the re-arm now WAITS for that tick's lock
 * release (which happens AFTER the tick's own cursor write), so the re-arm's
 * write is guaranteed to land AFTER, never lost to it.
 *
 * fix-wave-3 R10 — UNLIKE `ForceFinanceDeltaRun` (whose lock stopped being
 * load-bearing once its own write became targeted, R2), this lock genuinely
 * IS load-bearing: this method and a concurrent tick write the SAME `cursor`
 * column (`SyncStateRepository`'s docblock claim that they "touch disjoint
 * columns" is FALSE — only the lock keeps them from racing; see the LOW fix
 * there). So this still THROWS when the lock stays busy for the whole
 * budget, never writing unlocked — but now throws `FinanceSyncLockBusyError`
 * (a `DomainError`, mapped by `errorHandler` to HTTP 503 + a `Retry-After`
 * header) instead of a bare `Error` that fell through to a generic 500. The
 * budget itself was ALSO re-measured and bumped: fix-wave-2 sized it to GR's
 * fetch latency alone (1019-1251ms); the tick actually holds this lock
 * through 4 `$transaction`s + N upserts AFTER the fetch returns (real hold
 * plausibly 2-3s) — 40x100ms=4000ms leaves comfortable margin above that.
 */
export class RearmFinanceReceiptsBackfill {
  constructor(
    private readonly state: SyncStateRepository,
    private readonly lock: Pick<DistributedLock, 'tryAcquire' | 'release'>,
    private readonly now: () => Date = () => new Date(),
    private readonly opts: RearmFinanceReceiptsBackfillOptions = {},
  ) {}

  async execute(): Promise<RearmFinanceReceiptsBackfillResult> {
    const cursor = `${arYearMonth(this.now())}:0`;
    const maxAttempts = this.opts.maxLockAttempts ?? DEFAULT_MAX_LOCK_ATTEMPTS;
    const delayMs = this.opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

    let acquired = false;
    for (let attempt = 0; attempt < maxAttempts && !acquired; attempt++) {
      acquired = await this.lock.tryAcquire(SCHEDULER_LOCK_KEY);
      if (!acquired && attempt < maxAttempts - 1) await sleep(delayMs);
    }

    if (!acquired) {
      // fix-wave-3 R10 — this lock IS load-bearing (both this method and a
      // concurrent tick write `cursor`), so still fail loud, never write
      // unlocked. But surface it as a retriable 503, not a generic 500.
      throw new FinanceSyncLockBusyError(SCHEDULER_LOCK_KEY, this.opts.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS);
    }

    try {
      await this.state.rearmCursor(BACKFILL_ENTITY, cursor, 'rearmed');
      return { rearmed: true, cursor };
    } finally {
      await this.lock.release(SCHEDULER_LOCK_KEY);
    }
  }
}
