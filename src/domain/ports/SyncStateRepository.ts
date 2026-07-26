export interface SyncState {
  /** Logical entity key, e.g. "gr-clients". */
  entity: string;
  /**
   * Watermark for the next delta. For GR clients this is the date (DD-MM-AAAA)
   * of the last successful run; null means "never synced → backfill".
   */
  cursor: string | null;
  lastRunAt: Date | null;
  /** "ok" or "error: <message>". */
  lastResult: string | null;
  /** Cumulative rows touched on the last run. */
  itemsSynced: number;
}

export interface SyncStateRepository {
  get(entity: string): Promise<SyncState | null>;
  save(state: SyncState): Promise<void>;
  /**
   * fix-wave-2 R2 — TARGETED single-column update: clears `lastRunAt` without
   * reading or rewriting `cursor`/`lastResult`/`itemsSynced`. No-op if the row
   * doesn't exist yet (nothing to force — a first tick is already "due").
   *
   * Replaces the read-modify-write `ForceFinanceDeltaRun` used to do
   * (`save({...prior, lastRunAt: null})`), which raced a concurrent scheduler
   * tick: reading a stale full row and writing it back could REWIND `cursor`/
   * `itemsSynced` to the pre-tick snapshot (probed: cursor rewound from
   * `14-07-2026` back, `itemsSynced` 9→5). A single-column UPDATE can never
   * clobber those other columns, no matter how a concurrent tick's own
   * `save()` interleaves — the race disappears BY CONSTRUCTION, not by
   * winning a lock.
   */
  clearLastRunAt(entity: string): Promise<void>;
  /**
   * fix-wave-2 R6 — TARGETED update: sets ONLY `cursor` and `lastResult`,
   * NEVER reading or rewriting `lastRunAt`/`itemsSynced`. Upserts a fresh row
   * (`lastRunAt: null`, `itemsSynced: 0`) if none exists yet. Used by
   * `RearmFinanceReceiptsBackfill`.
   *
   * fix-wave-3 LOW (doc fix) — this docblock previously claimed this call and
   * a concurrent tick's own `save()` "touch disjoint sets of columns at the
   * SQL level". That is FALSE: both write `cursor` (and `lastResult`) — a
   * tick's end-of-run `save()` writes the SAME columns this targets. What
   * actually prevents corruption is NOT column disjointness, it's that
   * `RearmFinanceReceiptsBackfill` (R10) holds the SAME `finance-receipts-
   * ingest` lock the scheduler's `tick()` holds for its entire run, so the
   * two calls are strictly ORDERED, never interleaved — unlike
   * `clearLastRunAt`/`ForceFinanceDeltaRun` (R2), whose targeted write is
   * safe in EITHER order and therefore does NOT depend on the lock for
   * correctness (only for avoiding weird interleaving with a tick's OTHER
   * writes).
   */
  rearmCursor(entity: string, cursor: string, lastResult: string): Promise<void>;
}
