/**
 * finance-growth Fase 3 (design.md Wiring — "corre 1 vez por noche... el
 * snapshot SÍ es un batch nocturno legítimo, a diferencia del ingest: agrega
 * meses ya cerrados, no compite por el presupuesto de GR") — nightly job that
 * (re)computes `FinanceMonthlySnapshot`/`FinanceCohortSnapshot`.
 *
 * Molde `SnoozeReactivationScheduler` (setInterval + timer.unref() + inFlight
 * reentrancy guard + cross-replica `DistributedLock`), WITHOUT the dynamic
 * backoff `FinanceReceiptIngestScheduler` needs — this job doesn't call GR at
 * all (Decision 5: the metrics engine never talks to GestionRealPort), so
 * there's no upstream to degrade against; a plain fixed 24h interval is
 * exactly the "batch nocturno legítimo" design.md calls for.
 *
 * finance-growth Fase 3 rework (J3) — persists its own run status via
 * `SyncStateRepository` (entity `'finance-snapshot-job'`, reused — no new
 * port), read back by `GetFinanceSyncStatus`/`GET /sync/status`. Before this,
 * a failing job had NO status anywhere: errors went to `console.log` and the
 * `runOnce()` return value nobody consumed (`main.ts` is fire-and-forget).
 * If this job failed EVERY night, the panel would show the last good month
 * FOREVER — indistinguishable from "nothing changed", and there wasn't even
 * a status field that COULD lie about it (the same class of gap the user
 * already flagged in Fase 1, "el status decía ok con el carril muerto" —
 * except here there was no status at all).
 *
 * Which months get (re)computed each run — NOT spelled out verbatim in
 * design.md, decided here:
 *  - Monthly snapshot: the CURRENT calendar month (AR) AND the previous one.
 *    Recomputing "today's" partial month lets the panel show month-to-date
 *    numbers that improve as the ingest carriles fill in; recomputing the
 *    previous month absorbs cash that arrived late (a backfill page that
 *    lands after that month first closed). Older months are stable once
 *    their ingest coverage is complete and are NOT recomputed every night —
 *    unbounded reprocessing of the full 163-month history nightly would cost
 *    real DB time for zero observable change once a month's data has settled.
 *  - Cohort snapshot: the previous `cohortLookbackMonths` (default 24) cohort
 *    months, each re-executed (idempotent upsert) so a cohort's 3/6/12-month
 *    rows appear as soon as they age into existence, without needing a
 *    separate "which cohorts are due" query.
 */
import type { BuildFinanceMonthlySnapshot } from '@application/use-cases/finance/BuildFinanceMonthlySnapshot';
import type { BuildFinanceCohortSnapshot } from '@application/use-cases/finance/BuildFinanceCohortSnapshot';
import type { DistributedLock } from '@domain/ports/DistributedLock';
import type { SyncStateRepository } from '@domain/ports/SyncStateRepository';
import { previousYearMonth } from '@application/use-cases/finance/financeDates';
import { readSnapshotRebuildQueue, clearSnapshotRebuildMonths, nightlyRebuildHorizon } from '@application/use-cases/finance/financeSnapshotRebuildQueue';

const LOCK_KEY = 'finance-snapshot-job';
/** finance-growth Fase 3 rework (J3) — SAME entity key `GetFinanceSyncStatus.SNAPSHOT_JOB_ENTITY` reads from. */
const STATE_ENTITY = 'finance-snapshot-job';

export interface FinanceSnapshotSchedulerOptions {
  intervalMs: number;
  cohortLookbackMonths?: number;
  silent?: boolean;
}

export interface FinanceSnapshotRunSummary {
  skipped?: boolean;
  monthsComputed?: string[];
  cohortsComputed?: string[];
  errors?: string[];
}

export class FinanceSnapshotScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;

  constructor(
    private readonly buildMonthly: BuildFinanceMonthlySnapshot,
    private readonly buildCohort: BuildFinanceCohortSnapshot,
    private readonly opts: FinanceSnapshotSchedulerOptions,
    private readonly lock: DistributedLock,
    private readonly now: () => Date = () => new Date(),
    /** finance-growth Fase 3 rework (J3) — optional so existing tests that never assert persistence don't need to thread a fake; production wiring (bootstrapFinanceSnapshotJob) always provides a real one. */
    private readonly state?: SyncStateRepository,
  ) {}

  start(): void {
    this.log(`[finance-snapshot] started, interval=${this.opts.intervalMs}ms`);
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.opts.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.log('[finance-snapshot] stopped');
  }

  async runOnce(): Promise<FinanceSnapshotRunSummary> {
    // Synchronous inFlight guard BEFORE the first await — mirrors every other
    // scheduler in the repo (two overlapping ticks would otherwise both try
    // to acquire/hold the advisory lock from the same process/session).
    if (this.inFlight) {
      this.log('[finance-snapshot] skipped -- previous run still in flight');
      return { skipped: true };
    }
    this.inFlight = true;

    let acquired = false;
    try {
      acquired = await this.lock.tryAcquire(LOCK_KEY);
      if (!acquired) {
        this.log('[finance-snapshot] skipped -- lock held by another instance');
        return { skipped: true };
      }

      const errors: string[] = [];
      // fix-wave-2 RFX1 — the horizon comes from `nightlyRebuildHorizon`, the
      // SAME function the rebuild-queue module documents as "what the nightly
      // covers". It used to be re-derived inline here; two expressions of one
      // concept is how they drift.
      const [previous, currentYearMonth] = nightlyRebuildHorizon(this.now());

      // gr-receipt-annulment fix-wave RF3 — months an ingest carril queued
      // because an ANNULMENT flipped a receipt belonging OUTSIDE this job's
      // two-month horizon. Read (not drained) up front: each month is removed
      // only after ITS OWN rebuild succeeded, so a failure is retried the next
      // night instead of being silently dropped, and a flip queued WHILE this
      // run is in flight survives the clear (`clearSnapshotRebuildMonths`
      // re-reads and subtracts).
      const queued = this.state ? await readSnapshotRebuildQueue(this.state) : [];
      const horizon: string[] = [previous, currentYearMonth];
      const extraQueued = queued.filter((ym) => !horizon.includes(ym));

      const monthsComputed: string[] = [];
      for (const ym of [...horizon, ...extraQueued]) {
        try {
          await this.buildMonthly.execute(ym);
          monthsComputed.push(ym);
        } catch (err) {
          errors.push(`monthly(${ym}): ${(err as Error).message}`);
        }
      }

      if (this.state && queued.length > 0) {
        // A queued month that ALSO fell inside the horizon was rebuilt by the
        // horizon pass — it counts as done too.
        const repaired = queued.filter((ym) => monthsComputed.includes(ym));
        if (repaired.length > 0) {
          const remaining = await clearSnapshotRebuildMonths(this.state, repaired, this.now());
          this.log(
            `[finance-snapshot] rebuild queue: reconstruidos ${repaired.join(',')} — pendientes ${remaining.join(',') || '(ninguno)'}`,
          );
        }
      }

      const cohortsComputed: string[] = [];
      const lookback = this.opts.cohortLookbackMonths ?? 24;
      let cohortYm = previous;
      for (let i = 0; i < lookback; i++) {
        try {
          const rows = await this.buildCohort.execute(cohortYm);
          if (rows.length > 0) cohortsComputed.push(cohortYm);
        } catch (err) {
          errors.push(`cohort(${cohortYm}): ${(err as Error).message}`);
        }
        cohortYm = previousYearMonth(cohortYm);
      }

      this.log(
        `[finance-snapshot] tick: months=${monthsComputed.join(',')} cohorts=${cohortsComputed.length} errors=${errors.length}`,
      );
      await this.persistState(errors.length > 0 ? `error: ${errors.join('; ')}` : 'ok', monthsComputed.length);
      return { monthsComputed, cohortsComputed, errors: errors.length > 0 ? errors : undefined };
    } catch (err) {
      const message = (err as Error).message;
      this.log(`[finance-snapshot] tick ERROR (lock): ${message}`);
      await this.persistState(`error: ${message}`, 0);
      return { errors: [message] };
    } finally {
      if (acquired) await this.lock.release(LOCK_KEY);
      this.inFlight = false;
    }
  }

  /**
   * finance-growth Fase 3 rework (J3) — best-effort: a persistence failure
   * here must never mask the tick's own result (it's already been logged/
   * returned above) nor throw out of `runOnce()`. `itemsSynced` here means
   * "months (re)computed in THIS tick" — a deliberate deviation from the
   * ingest entities' cumulative-historical-total convention (documented
   * here so it isn't mistaken for a bug the next time someone compares the
   * two): a cumulative total would be meaningless for a job that RE-computes
   * the same 2-month window every night rather than making forward progress
   * through a backlog.
   */
  private async persistState(lastResult: string, itemsSynced: number): Promise<void> {
    if (!this.state) return;
    try {
      await this.state.save({ entity: STATE_ENTITY, cursor: null, lastRunAt: this.now(), lastResult, itemsSynced });
    } catch (err) {
      this.log(`[finance-snapshot] failed to persist run status (non-fatal): ${(err as Error).message}`);
    }
  }

  private log(msg: string): void {
    if (!this.opts.silent) console.log(msg);
  }
}
