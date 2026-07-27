/**
 * finance-growth Fase 3 (design.md Data Model, Decision 4) — retention
 * cohort row: of the contracts activated in `cohortYearMonth`
 * (`originalCount`), how many (`survivingCount`) were still active
 * `monthsElapsed` (3 | 6 | 12) months later. Computed nightly by
 * `BuildFinanceCohortSnapshot`. A cohort younger than `monthsElapsed` NEVER
 * gets a row for that age — spec.md "no inventa un dato que no puede existir
 * aún".
 */
export interface FinanceCohortSnapshot {
  cohortYearMonth: string; // "YYYY-MM"
  monthsElapsed: number; // 3 | 6 | 12
  originalCount: number;
  survivingCount: number;
  computedAt: Date;
}

export type FinanceCohortSnapshotUpsert = Omit<FinanceCohortSnapshot, 'computedAt'>;

export interface FinanceCohortSnapshotRepository {
  /** All age rows persisted for one cohort month, ordered by `monthsElapsed` ASC. */
  listByCohort(cohortYearMonth: string): Promise<FinanceCohortSnapshot[]>;
  /** Idempotent upsert keyed by `(cohortYearMonth, monthsElapsed)`. */
  upsert(
    cohortYearMonth: string,
    monthsElapsed: number,
    data: { originalCount: number; survivingCount: number },
  ): Promise<FinanceCohortSnapshot>;
}
