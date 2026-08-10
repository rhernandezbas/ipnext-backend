/**
 * gr-receipt-annulment (design.md Decision 4) — marker base class for any
 * failure that happens AFTER a successful GR fetch: a persistence write
 * failure, or the systemic annulment guard aborting a page. Both mean "GR
 * answered fine THIS tick" — `FinanceReceiptIngestScheduler.trackGrHealth`
 * checks `instanceof FinanceReceiptPostFetchError` (not the concrete
 * subclass) so the SHARED request-pacing backoff never escalates for either
 * cause. Kept `abstract` — always thrown as one of its subclasses, never
 * itself, so a `catch` can distinguish PERSISTENCE from GUARD when it needs to.
 */
export abstract class FinanceReceiptPostFetchError extends Error {}

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
 *
 * gr-receipt-annulment — now extends `FinanceReceiptPostFetchError` (was a
 * bare `Error` subclass). `trackGrHealth` checking `instanceof
 * FinanceReceiptPostFetchError` instead of `instanceof
 * FinanceReceiptPersistenceError` directly is a NO-OP for this class (every
 * existing `instanceof FinanceReceiptPersistenceError` check anywhere else in
 * the codebase is UNCHANGED and still `true`) — it only ADDS the sibling
 * `FinanceReceiptAnnulmentGuardError` to the set `trackGrHealth` recognizes.
 */
export class FinanceReceiptPersistenceError extends FinanceReceiptPostFetchError {
  constructor(public readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'FinanceReceiptPersistenceError';
  }
}

/**
 * gr-receipt-annulment (design.md Decision 4) — thrown by
 * `financeAnnulmentGuard` when a page's annulled ratio exceeds
 * `FinanceReceiptSyncConfig.annulmentGuardMaxPct` (with the
 * `annulmentGuardMinCount` floor). Extends `FinanceReceiptPostFetchError` for
 * the SAME reason `FinanceReceiptPersistenceError` does: GR answered fine —
 * the abort is a data-quality decision made AFTER the fetch, not a sign GR is
 * unwell. Kept DISTINCT from `FinanceReceiptPersistenceError` (not reused) —
 * the two failure modes are diagnosed differently by an operator (a P2000 vs.
 * a centinela-format drift) even though the scheduler treats them the same.
 */
export class FinanceReceiptAnnulmentGuardError extends FinanceReceiptPostFetchError {
  constructor(message: string) {
    super(message);
    this.name = 'FinanceReceiptAnnulmentGuardError';
  }
}
