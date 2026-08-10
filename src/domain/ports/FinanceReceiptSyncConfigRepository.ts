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
  /** gr-receipt-annulment (design.md Decision 2/7) — days back the reconcile lane re-scans. Effective floor 35 (see `normalizeFinanceReceiptSyncConfig`). */
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
 * `reconcileWindowDays` below `RECONCILE_WINDOW_DAYS_MIN_EFFECTIVE` (35) is
 * REJECTED even though it's inside the nominal `[1, 90]` range — the window
 * MUST be >= the snapshot rebuild window (current + previous month, worst
 * case 35d) or a repaired receipt never reaches the dashboard (finance-growth
 * spec.md scenario 15, "The window-vs-rebuild invariant is enforced").
 */
const RECONCILE_WINDOW_DAYS_MIN = 1;
const RECONCILE_WINDOW_DAYS_MAX = 90;
/** The dashboard-visibility invariant floor — see docblock above. Coincides with the default on purpose (Decision 7). */
const RECONCILE_WINDOW_DAYS_MIN_EFFECTIVE = 35;
const RECONCILE_CHECK_INTERVAL_MS_MIN = 600000;
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

  // The nominal [1,90] check first, THEN the dashboard-visibility floor — a
  // value that fails the nominal range falls back to the default (35) same as
  // any other knob; a value that passes [1,90] but sits BELOW 35 falls back
  // too (finance-growth spec.md scenario 15), never clamped up to 35.
  const nominalWindow = normalizedIntInRange(
    raw.reconcileWindowDays,
    RECONCILE_WINDOW_DAYS_MIN,
    RECONCILE_WINDOW_DAYS_MAX,
    FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS.reconcileWindowDays,
  );
  const reconcileWindowDays =
    nominalWindow < RECONCILE_WINDOW_DAYS_MIN_EFFECTIVE ? FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS.reconcileWindowDays : nominalWindow;

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
