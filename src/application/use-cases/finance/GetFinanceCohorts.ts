import type { FinanceCohortSnapshotRepository, FinanceCohortSnapshot } from '@domain/ports/FinanceCohortSnapshotRepository';
import { isValidYearMonth, compareYearMonth, enumerateYearMonths, assertYearMonthRangeWidth } from '@application/use-cases/finance/financeDates';
import { roundToScale } from '@application/use-cases/finance/financeDecimal';
import { FinanceValidationError } from '@domain/errors/finance';

const COHORT_AGES = [3, 6, 12] as const;

export interface CohortSurvivalPoint {
  survivingCount: number;
  pct: number;
}

export interface FinanceCohortRow {
  cohortYearMonth: string;
  originalCount: number;
  survival: {
    /** `null` = the cohort hasn't reached this age yet (or the nightly job never ran for it) — NEVER a guessed 0/100. */
    m3: CohortSurvivalPoint | null;
    m6: CohortSurvivalPoint | null;
    m12: CohortSurvivalPoint | null;
  };
}

export interface GetFinanceCohortsResult {
  cohorts: FinanceCohortRow[];
  /**
   * fix-wave-4 (🟡9) — mirrors `/overview`'s `monthsWithoutSnapshot`: every
   * `cohortYearMonth` in `[fromCohort, toCohort]` with NO `FinanceCohortSnapshot`
   * row at ALL (the nightly job/backfill never ran for it). Without this,
   * `cohorts: []` was indistinguishable from "no cohort had any altas" — the
   * measured prod state TODAY (the backfill never ran) returns exactly the
   * mute `[]` `/overview` already learned not to return on its own.
   */
  monthsWithoutCohortSnapshot: string[];
}

/**
 * finance-growth Fase 4 — `GET /cohorts`. Pure reader over
 * `FinanceCohortSnapshot` (design.md Decision 4: cohorts are precomputed
 * nightly by `BuildFinanceCohortSnapshot`, never recomputed live here). A
 * cohort month absent from the query result never had the job run for it —
 * it's simply OMITTED from `cohorts` (never a row of zeros); an age missing
 * WITHIN a present cohort (e.g. a 5-month-old cohort has no `m12` row yet)
 * surfaces as `null` for that age only.
 */
export class GetFinanceCohorts {
  constructor(private readonly cohortRepo: FinanceCohortSnapshotRepository) {}

  async execute(fromCohort: string, toCohort: string): Promise<GetFinanceCohortsResult> {
    if (!isValidYearMonth(fromCohort) || !isValidYearMonth(toCohort)) {
      throw new FinanceValidationError('"fromCohort" y "toCohort" deben tener formato "YYYY-MM"');
    }
    if (compareYearMonth(fromCohort, toCohort) > 0) {
      throw new FinanceValidationError('"fromCohort" debe ser <= "toCohort"');
    }
    assertYearMonthRangeWidth(fromCohort, toCohort);

    const rows = await this.cohortRepo.listByCohortRange(fromCohort, toCohort);

    const byMonth = new Map<string, FinanceCohortSnapshot[]>();
    for (const r of rows) {
      const list = byMonth.get(r.cohortYearMonth);
      if (list) list.push(r);
      else byMonth.set(r.cohortYearMonth, [r]);
    }

    const cohorts: FinanceCohortRow[] = [...byMonth.entries()]
      .sort(([a], [b]) => compareYearMonth(a, b))
      .map(([cohortYearMonth, ageRows]) => {
        const originalCount = ageRows[0].originalCount;
        const pointFor = (monthsElapsed: number): CohortSurvivalPoint | null => {
          const row = ageRows.find((r) => r.monthsElapsed === monthsElapsed);
          if (!row) return null;
          return {
            survivingCount: row.survivingCount,
            pct: originalCount > 0 ? roundToScale((row.survivingCount / originalCount) * 100, 2) : 0,
          };
        };
        return {
          cohortYearMonth,
          originalCount,
          survival: { m3: pointFor(3), m6: pointFor(6), m12: pointFor(12) },
        };
      });

    const monthsWithoutCohortSnapshot = enumerateYearMonths(fromCohort, toCohort).filter((m) => !byMonth.has(m));

    return { cohorts, monthsWithoutCohortSnapshot };
  }
}

// Re-export the ages tuple so tests/consumers never hardcode 3/6/12 twice.
export { COHORT_AGES };
