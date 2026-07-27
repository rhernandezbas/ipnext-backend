/**
 * finance-growth Fase 1 — typed config for the shared-budget receipt-ingest
 * pacing (design.md Decision 4b). Molde `GestionRealIngestConfigRepository`.
 * Single-row table (`@default("singleton")`). No HTTP endpoint in this change
 * (design.md "FinanceReceiptSyncConfig ... no tiene endpoint HTTP propio") —
 * it's an operational knob, edited by migration/DB, not a business settable.
 */
export interface FinanceReceiptSyncConfig {
  enabled: boolean;
  /** Base pacing of the SHARED budget — ms between ticks when not degraded. */
  requestIntervalMs: number;
  /** Backoff ceiling — effective interval never exceeds this under sustained failures. */
  maxRequestIntervalMs: number;
  /** How often the delta lane re-checks "today" when it has no pending pages. */
  deltaCheckIntervalMs: number;
  /** Historical floor for the backfill lane, "YYYY-MM". */
  backfillFloorYearMonth: string;
  /**
   * fix-wave-2 LOW — after this many CONSECUTIVE delta failures, the backfill
   * lane starts getting turns even though the delta remains "due" (F4
   * anti-starvation circuit breaker). Was hardcoded in
   * `FinanceReceiptIngestScheduler` while F6 argues the WHOLE pacing model
   * should be editable in DB without a redeploy — moved here for consistency.
   */
  deltaStarvationThreshold: number;
}

export interface FinanceReceiptSyncConfigRepository {
  /** Current config; returns seeded defaults if no row has been persisted yet. */
  get(): Promise<FinanceReceiptSyncConfig>;
  update(patch: Partial<FinanceReceiptSyncConfig>): Promise<FinanceReceiptSyncConfig>;
}

/** Defaults mirrored from the migration seed (design.md Decision 4b). */
export const FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS: FinanceReceiptSyncConfig = {
  enabled: true,
  requestIntervalMs: 20000,
  maxRequestIntervalMs: 300000,
  deltaCheckIntervalMs: 300000,
  backfillFloorYearMonth: '2013-01',
  deltaStarvationThreshold: 3,
};
