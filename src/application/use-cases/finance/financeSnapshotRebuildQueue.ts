import { SyncStateRepository } from '@domain/ports/SyncStateRepository';
import { arYearMonth, previousYearMonth, isValidYearMonth } from './financeDates';

/**
 * gr-receipt-annulment fix-wave RF3 — the bridge between the ingest carriles
 * and the nightly snapshot job.
 *
 * The problem it closes: `FinanceSnapshotScheduler` only recomputes
 * `[mes anterior, mes corriente]`. That window is 28-62 days wide depending on
 * the day of the month — on the 1st of March it guarantees only 28 days of
 * coverage, NOT the 35 the reconcile window was sized against. A receipt from
 * 31-01 annulled on 01-03 is 29 days old: comfortably INSIDE the reconcile
 * window, so the mirror flips it correctly — and just as comfortably OUTSIDE
 * the rebuild horizon, so January's snapshot keeps the cash forever. The
 * dashboard would then disagree with the mirror permanently, with every test
 * green and no signal anywhere.
 *
 * The previous defense was a normalizer floor (`reconcileWindowDays >= 35`)
 * justified by "the rebuild covers 35 days" — a number that is simply not
 * true of `[previous, current]`, and which no arithmetic supports. That floor
 * is GONE (fix-wave RF3): the window is now a coverage/cost knob, free in
 * `[1, 90]`, and CORRECTNESS is enforced here instead — whenever a flip lands
 * on a month outside the nightly horizon, that month is QUEUED and the next
 * nightly run rebuilds it explicitly.
 *
 * Persisted through `SyncStateRepository` (entity below) rather than an
 * in-process set: the two schedulers are independent objects, and a queue that
 * dies with the process would silently lose exactly the repairs it exists to
 * guarantee.
 */
export const SNAPSHOT_REBUILD_QUEUE_ENTITY = 'finance-snapshot-rebuild-queue';

/**
 * Hard cap on the persisted queue (a `SyncState.cursor` string, ~8 bytes per
 * month = ~2 KB at the cap). 240 months = the same 20-year span
 * `BackfillFinanceMonthlySnapshots`/`assertYearMonthRangeWidth` already treat
 * as the generous outer bound for a finance range. Overflow drops the OLDEST
 * months (the ones whose rebuild is least urgent) and says so loudly.
 */
export const SNAPSHOT_REBUILD_QUEUE_MAX_MONTHS = 240;

/**
 * `[mes anterior, mes corriente]` — the months `FinanceSnapshotScheduler`
 * recomputes on EVERY nightly run, no queue needed. THE definition of that
 * horizon: the scheduler destructures this instead of re-deriving
 * `arYearMonth`/`previousYearMonth` inline, so there is exactly one place
 * where "what the nightly covers" is decided.
 *
 * fix-wave-2 RFX1 — there used to be an `isWithinNightlyRebuildHorizon(ym,
 * now)` companion, used by the ingest to decide whether to queue a flip's
 * month. It is GONE, not merely unused: asking that question with the
 * INGEST's clock about a horizon the NIGHTLY recomputes with its own is a
 * race that no amount of care at the call site can fix (see
 * `financeReceiptPageIngest.persistReceiptPage` for the measured hole). The
 * ingest now queues on a predicate that involves no second clock at all —
 * "not the current month". This function survives only as the NIGHTLY's own
 * statement about the NIGHTLY's own horizon, evaluated with the nightly's own
 * clock, which is the one use that was never racy.
 */
export function nightlyRebuildHorizon(now: Date): [previous: string, current: string] {
  const current = arYearMonth(now);
  return [previousYearMonth(current), current];
}

function parseQueue(cursor: string | null | undefined): string[] {
  if (!cursor) return [];
  return [...new Set(cursor.split(',').map((s) => s.trim()).filter((s) => isValidYearMonth(s)))].sort();
}

/** Current pending months, ascending. Safe against a corrupt/hand-edited cursor (garbage entries are dropped, never re-derived). */
export async function readSnapshotRebuildQueue(state: SyncStateRepository): Promise<string[]> {
  const prior = await state.get(SNAPSHOT_REBUILD_QUEUE_ENTITY);
  return parseQueue(prior?.cursor);
}

/**
 * Adds `yearMonths` to the pending queue (idempotent — re-queuing a month
 * already pending is a no-op that does not even write). Returns the resulting
 * queue.
 */
export async function enqueueSnapshotRebuild(state: SyncStateRepository, yearMonths: string[], now: Date): Promise<string[]> {
  const wanted = [...new Set(yearMonths.filter((ym) => isValidYearMonth(ym)))];
  if (wanted.length === 0) return readSnapshotRebuildQueue(state);

  const existing = await readSnapshotRebuildQueue(state);
  const merged = [...new Set([...existing, ...wanted])].sort();
  if (merged.length === existing.length) return existing; // nothing new — merged always ⊇ existing

  let queue = merged;
  if (queue.length > SNAPSHOT_REBUILD_QUEUE_MAX_MONTHS) {
    const dropped = queue.slice(0, queue.length - SNAPSHOT_REBUILD_QUEUE_MAX_MONTHS);
    queue = queue.slice(queue.length - SNAPSHOT_REBUILD_QUEUE_MAX_MONTHS);
    console.warn(
      `[finance-snapshot-rebuild-queue] queue over ${SNAPSHOT_REBUILD_QUEUE_MAX_MONTHS} months — dropping the OLDEST ${dropped.length} (${dropped.join(',')}). Rebuild them by hand via POST /api/finance/growth/sync/backfill-snapshots.`,
    );
  }

  await state.save({
    entity: SNAPSHOT_REBUILD_QUEUE_ENTITY,
    cursor: queue.join(','),
    lastRunAt: now,
    lastResult: `pending ${queue.length}: ${queue.join(',')}`,
    itemsSynced: queue.length,
  });
  return queue;
}

/**
 * Removes the months the nightly job actually rebuilt. Deliberately NOT a
 * wholesale "drain": it RE-READS the queue and subtracts, so a flip enqueued
 * by an ingest tick WHILE the nightly rebuild was running survives instead of
 * being erased by the clear.
 */
export async function clearSnapshotRebuildMonths(state: SyncStateRepository, months: string[], now: Date): Promise<string[]> {
  if (months.length === 0) return readSnapshotRebuildQueue(state);
  const done = new Set(months);
  const existing = await readSnapshotRebuildQueue(state);
  const remaining = existing.filter((ym) => !done.has(ym));
  if (remaining.length === existing.length) return existing;

  await state.save({
    entity: SNAPSHOT_REBUILD_QUEUE_ENTITY,
    cursor: remaining.length === 0 ? null : remaining.join(','),
    lastRunAt: now,
    lastResult: remaining.length === 0 ? 'empty' : `pending ${remaining.length}: ${remaining.join(',')}`,
    itemsSynced: remaining.length,
  });
  return remaining;
}
