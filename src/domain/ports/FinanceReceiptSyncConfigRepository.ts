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
  /** gr-receipt-annulment (design.md Decision 1/2) — runtime kill-switch for the reconcile lane, independent of `enabled`. */
  reconcileEnabled: boolean;
  /**
   * gr-receipt-annulment (design.md Decision 2/7) — days back the reconcile
   * lane re-scans, in `[1, 90]` (default 35). fix-wave RF3: this is a COVERAGE
   * knob (how late a confirmation/annulment can arrive and still be caught),
   * NOT a correctness invariant — an annulment landing outside the nightly
   * snapshot horizon queues its month for rebuild regardless of this value.
   */
  reconcileWindowDays: number;
  /** gr-receipt-annulment (design.md Decision 2/9) — how often (ms) the reconcile lane re-checks whether a fresh sweep is due once idle. */
  reconcileCheckIntervalMs: number;
  /** gr-receipt-annulment (design.md Decision 4/7) — systemic guard: abort threshold, percent of a page/run marked `anulado: true` (strict `>`). */
  annulmentGuardMaxPct: number;
  /** gr-receipt-annulment (design.md Decision 4/7) — systemic guard: absolute floor of annulled rows before the guard can fire. */
  annulmentGuardMinCount: number;
}

export interface FinanceReceiptSyncConfigRepository {
  /** Current config; returns seeded defaults if no row has been persisted yet. */
  get(): Promise<FinanceReceiptSyncConfig>;
  update(patch: Partial<FinanceReceiptSyncConfig>): Promise<FinanceReceiptSyncConfig>;
}

/** Defaults mirrored from the migration seed (design.md Decision 4b/7). */
export const FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS: FinanceReceiptSyncConfig = {
  enabled: true,
  requestIntervalMs: 20000,
  maxRequestIntervalMs: 300000,
  deltaCheckIntervalMs: 300000,
  backfillFloorYearMonth: '2013-01',
  deltaStarvationThreshold: 3,
  reconcileEnabled: true,
  reconcileWindowDays: 35,
  reconcileCheckIntervalMs: 21600000,
  annulmentGuardMaxPct: 5,
  annulmentGuardMinCount: 5,
};

/**
 * gr-receipt-annulment (design.md Decision 7) — "basura al lado SEGURO, no al
 * default": a raw row from `PrismaFinanceReceiptSyncConfigRepository.get()`
 * (or a hand-edited SQL row) can carry anything. Called by BOTH adapters
 * (Prisma + in-memory) in their `get()` — if only Prisma called this, tests
 * would run against different rules than production.
 *
 * fix-wave RF3 — the old "effective floor 35" for `reconcileWindowDays` is
 * GONE. It was justified as "the window MUST be >= the snapshot rebuild
 * window (current + previous month, worst case 35d)", and the arithmetic
 * behind it is simply wrong: `[mes anterior, mes corriente]` is 28-62 days
 * wide, so on the 1st of March it GUARANTEES 28, not 35. The invariant it
 * claimed to enforce was inverted (a 35-day window does NOT imply the rebuild
 * sees the repair) and the number invented. Correctness moved to where it can
 * actually hold: a flip landing on a month outside the nightly horizon queues
 * that month for an explicit rebuild (`financeSnapshotRebuildQueue`), whatever
 * the window is. What remains here is the plain nominal range — this knob is
 * now a coverage/cost trade-off, not a correctness invariant.
 */
const RECONCILE_WINDOW_DAYS_MIN = 1;
const RECONCILE_WINDOW_DAYS_MAX = 90;
/**
 * fix-wave RF17 — was 600000 (10 min). Measured: at that cadence the reconcile
 * lane is effectively ALWAYS due (a full sweep is many pages), taking ~71% of
 * the SHARED GR request budget and starving the backfill. 1 h is the floor
 * below which the value is treated as basura and the safe 6 h default applies.
 */
const RECONCILE_CHECK_INTERVAL_MS_MIN = 3600000;
const RECONCILE_CHECK_INTERVAL_MS_MAX = 86400000;
const ANNULMENT_GUARD_MAX_PCT_MIN = 1;
const ANNULMENT_GUARD_MAX_PCT_MAX = 100;
const ANNULMENT_GUARD_MIN_COUNT_MIN = 1;
const ANNULMENT_GUARD_MIN_COUNT_MAX = 1000;

function isFiniteInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v);
}

function normalizedIntInRange(v: unknown, min: number, max: number, fallback: number): number {
  if (!isFiniteInt(v) || v < min || v > max) return fallback;
  return v;
}

export function normalizeFinanceReceiptSyncConfig(raw: Partial<FinanceReceiptSyncConfig>): FinanceReceiptSyncConfig {
  const reconcileEnabled = typeof raw.reconcileEnabled === 'boolean' ? raw.reconcileEnabled : FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS.reconcileEnabled;

  // The nominal [1,90] range, and nothing else (fix-wave RF3 removed the
  // invented "effective floor 35"): 0/negative/non-integer/>90 is basura and
  // falls back to the safe default, never clamped.
  const reconcileWindowDays = normalizedIntInRange(
    raw.reconcileWindowDays,
    RECONCILE_WINDOW_DAYS_MIN,
    RECONCILE_WINDOW_DAYS_MAX,
    FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS.reconcileWindowDays,
  );

  const reconcileCheckIntervalMs = normalizedIntInRange(
    raw.reconcileCheckIntervalMs,
    RECONCILE_CHECK_INTERVAL_MS_MIN,
    RECONCILE_CHECK_INTERVAL_MS_MAX,
    FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS.reconcileCheckIntervalMs,
  );

  // `100` (= "never abort") is the DANGEROUS extreme for this knob — it sits
  // INSIDE the nominal [1,100] shape, so a naive range clamp would honor it.
  // Rejected explicitly, same criterion as `reconcileWindowDays`'s low floor
  // (design.md Decision 7: "el chequeo... es, knob por knob: ¿cuál de los dos
  // extremos del rango puede causar daño?").
  const nominalMaxPct = normalizedIntInRange(
    raw.annulmentGuardMaxPct,
    ANNULMENT_GUARD_MAX_PCT_MIN,
    ANNULMENT_GUARD_MAX_PCT_MAX,
    FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS.annulmentGuardMaxPct,
  );
  const annulmentGuardMaxPct =
    nominalMaxPct >= ANNULMENT_GUARD_MAX_PCT_MAX ? FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS.annulmentGuardMaxPct : nominalMaxPct;

  const annulmentGuardMinCount = normalizedIntInRange(
    raw.annulmentGuardMinCount,
    ANNULMENT_GUARD_MIN_COUNT_MIN,
    ANNULMENT_GUARD_MIN_COUNT_MAX,
    FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS.annulmentGuardMinCount,
  );

  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS.enabled,
    requestIntervalMs: isFiniteInt(raw.requestIntervalMs) ? raw.requestIntervalMs : FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS.requestIntervalMs,
    maxRequestIntervalMs: isFiniteInt(raw.maxRequestIntervalMs)
      ? raw.maxRequestIntervalMs
      : FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS.maxRequestIntervalMs,
    deltaCheckIntervalMs: isFiniteInt(raw.deltaCheckIntervalMs)
      ? raw.deltaCheckIntervalMs
      : FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS.deltaCheckIntervalMs,
    backfillFloorYearMonth:
      typeof raw.backfillFloorYearMonth === 'string' && raw.backfillFloorYearMonth !== ''
        ? raw.backfillFloorYearMonth
        : FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS.backfillFloorYearMonth,
    deltaStarvationThreshold: isFiniteInt(raw.deltaStarvationThreshold)
      ? raw.deltaStarvationThreshold
      : FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS.deltaStarvationThreshold,
    reconcileEnabled,
    reconcileWindowDays,
    reconcileCheckIntervalMs,
    annulmentGuardMaxPct,
    annulmentGuardMinCount,
  };
}
