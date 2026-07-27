/**
 * finance-growth Fase 1 (fix-wave-3 R8) — marks a failure as attributable to
 * PERSISTENCE (a repo `upsertBatch`/`upsertIfAbsent`/`state.save` write),
 * NEVER to the GR fetch itself. `SyncGrReceiptsDelta`/`SyncGrReceiptsBackfillBatch`
 * wrap ONLY the post-fetch persistence steps with this; `FinanceReceiptIngestScheduler`
 * uses the distinction to decide what the SHARED request-pacing backoff
 * (`effectiveIntervalMs`) should respond to.
 *
 * Before this fix, the backoff derived from `Math.max(deltaConsecutiveFailures,
 * backfillConsecutiveFailures, ...)` — ANY failure on either lane, persistence
 * included. Probed scenario: a single poisoned recibo makes
 * `applicationRepo.upsertBatch` throw on EVERY delta tick while GR itself is
 * perfectly healthy; after 4 failures the shared pacing was clamped to
 * `maxRequestIntervalMs` (300000ms) FOREVER, taking the healthy backfill lane
 * down with it (~15x slower: ~1 page/min -> ~1 page/10min, 163 months from ~4
 * days to ~2 months) — degrading F4's own anti-starvation remediation by the
 * exact failure mode F4 exists to protect against, just relocated from "zero
 * backfill calls" to "backfill calls at 1/15 speed", for a cause (persistence)
 * the backoff cannot do anything about (GR was never the problem).
 *
 * Per-lane health (`deltaConsecutiveFailures`/`backfillConsecutiveFailures`,
 * used for `/sync/status` and the F4 circuit breaker) is UNCHANGED by this —
 * it still counts ANY failure, persistence included; only the GR-facing
 * pacing signal (`grConsecutiveFailures`) is narrowed to fetch failures.
 * `.message` is passed through verbatim from `cause` so `SyncState.lastResult`
 * and existing message-matching tests (`toThrow('P2000')`, etc.) are unaffected.
 */
export class FinanceReceiptPersistenceError extends Error {
  constructor(public readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'FinanceReceiptPersistenceError';
  }
}
