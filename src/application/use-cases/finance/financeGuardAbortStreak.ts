import { SyncStateRepository } from '@domain/ports/SyncStateRepository';

/**
 * gr-receipt-annulment fix-wave-2 RFX3 — how many CONSECUTIVE systemic-guard
 * aborts a lane has taken on the sweep it is currently working, persisted as
 * its own thing.
 *
 * RF4 introduced the rule "three consecutive guard aborts abandon the sweep"
 * and derived the counter by regex-ing the marker `guardAborts=N` back out of
 * `SyncState.lastResult`. That made the counter a function of the LAST message
 * written, and every failure path writes that message: one `ECONNRESET`
 * between two aborts restarted the count at 1. The failure mode is not exotic
 * — a GR that is unwell enough to trip the annulment guard is exactly the GR
 * that also drops connections — and its consequence is that the threshold is
 * never reached: the lane alternates abort/error/abort/error and keeps
 * re-requesting the same poisoned page forever, which is the hammering RF4
 * existed to end. The bug was invisible because every RF4 test drove a CLEAN
 * streak.
 *
 * So the counter now lives in its own `SyncState` row, `"{lane}:guard-aborts"`:
 *  - only `recordGuardAbort` increments it (a non-guard failure writes nothing
 *    here, so the streak SURVIVES intercalated errors — the whole point);
 *  - `cursor` holds the sweep it belongs to (`"{fechaDesde}..{fechaHasta}"`),
 *    so a DIFFERENT sweep starts from zero without needing anybody to remember
 *    to reset it;
 *  - `clearGuardAbortStreak` zeroes it when a page succeeds or when the sweep
 *    is abandoned (the next sweep gets its own three attempts).
 *
 * Why a separate row and not a column: `SyncState` has no free field
 * (`cursor`/`itemsSynced` are load-bearing for the lane itself) and adding one
 * means a migration on a table three schedulers write to, for a counter that
 * is pure bookkeeping. A separate entity is also strictly safer under
 * concurrency — it can never clobber the lane's own cursor. Nothing enumerates
 * `SyncState` rows (`GetFinanceSyncStatus` reads by explicit key), so the extra
 * row is invisible to the status endpoint.
 *
 * Cost: one extra `get` per successful page (the clear reads before deciding
 * to write, and writes ONLY when there is something to clear — a healthy lane
 * pays a single indexed SELECT and never a write).
 */

/** Consecutive guard aborts on the SAME sweep after which the lane gives that sweep up. */
export const GUARD_ABORT_ABANDON_THRESHOLD = 3;

/** `"finance-receipts-delta"` → `"finance-receipts-delta:guard-aborts"`. */
export function guardAbortStreakEntity(laneEntity: string): string {
  return `${laneEntity}:guard-aborts`;
}

/**
 * The current streak. With `sweepKey`, a stored streak belonging to a
 * DIFFERENT sweep reads as 0 — a new sweep is a new count, by construction
 * rather than by anyone remembering to clear.
 */
export async function readGuardAbortStreak(state: SyncStateRepository, laneEntity: string, sweepKey?: string): Promise<number> {
  const row = await state.get(guardAbortStreakEntity(laneEntity));
  if (!row) return 0;
  if (sweepKey !== undefined && row.cursor !== sweepKey) return 0;
  // Defensive against a hand-edited/corrupt row: anything that is not a
  // positive integer counts as "no streak" (the SAFE side — it delays an
  // abandonment, it never abandons a healthy sweep prematurely).
  return Number.isInteger(row.itemsSynced) && row.itemsSynced > 0 ? row.itemsSynced : 0;
}

/** Increments the streak for `sweepKey` and returns the new value. The ONLY thing that increments it. */
export async function recordGuardAbort(state: SyncStateRepository, laneEntity: string, sweepKey: string, now: Date): Promise<number> {
  const streak = (await readGuardAbortStreak(state, laneEntity, sweepKey)) + 1;
  await state.save({
    entity: guardAbortStreakEntity(laneEntity),
    cursor: sweepKey,
    lastRunAt: now,
    lastResult: `${streak} abort(s) consecutivos del guard en ${sweepKey}`,
    itemsSynced: streak,
  });
  return streak;
}

/** Zeroes the streak (a page succeeded, or the sweep was abandoned). No-op — and no write — when there is nothing to clear. */
export async function clearGuardAbortStreak(state: SyncStateRepository, laneEntity: string, now: Date): Promise<void> {
  const row = await state.get(guardAbortStreakEntity(laneEntity));
  if (!row || row.itemsSynced === 0) return;
  await state.save({
    entity: guardAbortStreakEntity(laneEntity),
    cursor: null,
    lastRunAt: now,
    lastResult: 'sin aborts consecutivos pendientes',
    itemsSynced: 0,
  });
}
