import type { FinanceMonthlySnapshotRepository, FinanceMonthlySnapshot } from '@domain/ports/FinanceMonthlySnapshotRepository';
import type { FinanceInflationIndexRepository } from '@domain/ports/FinanceInflationIndexRepository';
import type { FinanceTargetsConfigRepository } from '@domain/ports/FinanceTargetsConfigRepository';
import { isValidYearMonth, compareYearMonth, enumerateYearMonths, assertYearMonthRangeWidth } from '@application/use-cases/finance/financeDates';
import { buildChainedIndex } from '@application/use-cases/finance/financeInflation';
import { roundToScale } from '@application/use-cases/finance/financeDecimal';
import { FinanceValidationError } from '@domain/errors/finance';

/** One month of the overview response — the snapshot's NOMINAL fields plus their deflated REAL counterparts (design.md HTTP Contract, "GET /overview"). */
export interface FinanceOverviewMonth {
  yearMonth: string;
  contractsActive: number;
  contractsNew: number;
  contractsChurned: number;
  contractsUpgraded: number;
  contractsDowngraded: number;
  mrrInicialArs: number;
  mrrNewArs: number;
  mrrUpgradeArs: number;
  mrrDowngradeArs: number;
  mrrChurnArs: number;
  mrrFinalArs: number;
  /** `null` when this month's `yearMonth` is in `realSeriesMissingMonths` — NEVER a guessed number. */
  mrrFinalRealArs: number | null;
  bridgeResidualArs: number;
  unpricedContractsActive: number;
  unpricedContractsPct: number;
  unpricedPlanChangeEvents: number;
  enforcementPlanChangeEventsExcluded: number;
  revenueTotalArs: number;
  /** `null` when this month's `yearMonth` is in `realSeriesMissingMonths`. */
  revenueTotalRealArs: number | null;
  collectionRatePct: number | null;
  revenueAttributableArs: number;
  unclassifiedAmountArs: number;
  attributionPct: number;
  arpuArs: number;
  churnContractsPct: number;
  churnRevenuePct: number | null;
}

export interface GetFinanceOverviewResult {
  months: FinanceOverviewMonth[];
  /**
   * finance-growth Fase 4 — months inside `[from, to]` with NO `FinanceMonthlySnapshot`
   * row at all (the nightly job only ever covers the current + previous month
   * unless `POST /sync/backfill-snapshots` ran for the rest — design.md
   * "Monthly snapshots must be backfillable on demand"). These months are
   * simply ABSENT from `months` — never a row of zeros. The FE renders this
   * list explicitly ("sin datos para estos meses"), the one signal that keeps
   * "no snapshot yet" from being misread as "revenue fell to zero".
   */
  monthsWithoutSnapshot: string[];
  /**
   * finance-growth Fase 4 fix-wave-4 (🔴1) — REPLACES the old single
   * `realSeriesTruncatedAt: string | null` marker. That field could only name
   * ONE cutoff month, but a gap in the backward direction (base strictly
   * after `from`) and a gap in the forward direction (base at/before `to`)
   * can BOTH exist at once, leaving a NON-CONTIGUOUS set of real months (e.g.
   * `02/03/04` real, `01/05/06` null) — the FE could not derive per-month
   * nullity from one string. This is the exhaustive, honest list: every
   * month in `[from, to]` whose real value could NOT be chained from
   * `inflationBaseYearMonth` (empty array = the full real series is
   * available). Read per-row nullity (`mrrFinalRealArs`/`revenueTotalRealArs`
   * === null) directly off the row, or cross-check against this list — never
   * infer it from a single cutoff again.
   */
  realSeriesMissingMonths: string[];
  inflationBaseYearMonth: string;
  metricBasis: 'cash_collected';
}

function toOverviewMonth(s: FinanceMonthlySnapshot, chainedIndex: number | undefined): FinanceOverviewMonth {
  return {
    yearMonth: s.yearMonth,
    contractsActive: s.contractsActive,
    contractsNew: s.contractsNew,
    contractsChurned: s.contractsChurned,
    contractsUpgraded: s.contractsUpgraded,
    contractsDowngraded: s.contractsDowngraded,
    mrrInicialArs: s.mrrInicialArs,
    mrrNewArs: s.mrrNewArs,
    mrrUpgradeArs: s.mrrUpgradeArs,
    mrrDowngradeArs: s.mrrDowngradeArs,
    mrrChurnArs: s.mrrChurnArs,
    mrrFinalArs: s.mrrFinalArs,
    mrrFinalRealArs: chainedIndex !== undefined ? roundToScale(s.mrrFinalArs / chainedIndex, 2) : null,
    bridgeResidualArs: s.bridgeResidualArs,
    unpricedContractsActive: s.unpricedContractsActive,
    unpricedContractsPct: s.unpricedContractsPct,
    unpricedPlanChangeEvents: s.unpricedPlanChangeEvents,
    enforcementPlanChangeEventsExcluded: s.enforcementPlanChangeEventsExcluded,
    revenueTotalArs: s.revenueTotalArs,
    revenueTotalRealArs: chainedIndex !== undefined ? roundToScale(s.revenueTotalArs / chainedIndex, 2) : null,
    collectionRatePct: s.collectionRatePct,
    revenueAttributableArs: s.revenueAttributableArs,
    unclassifiedAmountArs: s.unclassifiedAmountArs,
    attributionPct: s.attributionPct,
    arpuArs: s.arpuArs,
    churnContractsPct: s.churnContractsPct,
    churnRevenuePct: s.churnRevenuePct,
  };
}

/**
 * finance-growth Fase 4 — `GET /overview`. Reads precomputed
 * `FinanceMonthlySnapshot` rows (NOMINAL only, design.md Decision 4's
 * rationale: deflating in the snapshot would force a recompute of history
 * every time an IPC row loads late) and derives the REAL series at READ time
 * via `buildChainedIndex` (Decision 3).
 *
 * Two independent "never guess" rules enforced here, both load-bearing for
 * this endpoint NOT lying by omission:
 * 1. A month with no snapshot row is DROPPED from `months` (never a row of
 *    zeros) and surfaced in `monthsWithoutSnapshot`.
 * 2. A month whose real value can't be chained from `inflationBaseYearMonth`
 *    (no base configured, or a gap in `FinanceInflationIndex`) gets
 *    `mrrFinalRealArs`/`revenueTotalRealArs: null`, never `0` or the nominal
 *    value silently reused.
 */
export class GetFinanceOverview {
  constructor(
    private readonly snapshotRepo: FinanceMonthlySnapshotRepository,
    private readonly inflationRepo: FinanceInflationIndexRepository,
    private readonly targetsRepo: FinanceTargetsConfigRepository,
  ) {}

  async execute(from: string, to: string): Promise<GetFinanceOverviewResult> {
    if (!isValidYearMonth(from) || !isValidYearMonth(to)) {
      throw new FinanceValidationError('"from" y "to" deben tener formato "YYYY-MM"');
    }
    if (compareYearMonth(from, to) > 0) {
      throw new FinanceValidationError('"from" debe ser <= "to"');
    }
    assertYearMonthRangeWidth(from, to);

    const [snapshots, targets] = await Promise.all([this.snapshotRepo.listRange(from, to), this.targetsRepo.get()]);

    const allMonths = enumerateYearMonths(from, to);
    const snapshotByMonth = new Map(snapshots.map((s) => [s.yearMonth, s]));
    const monthsWithoutSnapshot = allMonths.filter((m) => !snapshotByMonth.has(m));

    const base = targets.inflationBaseYearMonth;
    let chainedIndexByMonth = new Map<string, number>();

    if (base !== '') {
      const boundsFrom = compareYearMonth(base, from) < 0 ? base : from;
      const boundsTo = compareYearMonth(base, to) > 0 ? base : to;
      const inflationRows = await this.inflationRepo.list(boundsFrom, boundsTo);
      const ratesByMonth = new Map(inflationRows.map((r) => [r.yearMonth, r.monthlyRatePct]));
      chainedIndexByMonth = buildChainedIndex(base, from, to, ratesByMonth).chainedIndexByMonth;
    }
    // base === '': no anchor configured at all — `chainedIndexByMonth` stays
    // empty, so EVERY month of `allMonths` below falls out as "missing" (the
    // entire real series is unknown, never a guessed base).

    // fix-wave-4 🔴1 — derived DIRECTLY from `allMonths` (every month of the
    // REQUEST, not of the snapshot data) against the map's own keys, so this
    // list is always exactly as precise as the per-row nulls it explains —
    // impossible to drift from them the way a single cutoff marker could.
    const realSeriesMissingMonths = allMonths.filter((m) => !chainedIndexByMonth.has(m));

    const months = snapshots.map((s) => toOverviewMonth(s, chainedIndexByMonth.get(s.yearMonth)));

    return {
      months,
      monthsWithoutSnapshot,
      realSeriesMissingMonths,
      inflationBaseYearMonth: base,
      metricBasis: 'cash_collected',
    };
  }
}
