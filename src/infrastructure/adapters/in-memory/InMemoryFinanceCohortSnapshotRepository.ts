import {
  FinanceCohortSnapshot,
  FinanceCohortSnapshotRepository,
} from '@domain/ports/FinanceCohortSnapshotRepository';

export class InMemoryFinanceCohortSnapshotRepository implements FinanceCohortSnapshotRepository {
  rows = new Map<string, FinanceCohortSnapshot>();

  private key(cohortYearMonth: string, monthsElapsed: number): string {
    return `${cohortYearMonth}:${monthsElapsed}`;
  }

  async listByCohort(cohortYearMonth: string): Promise<FinanceCohortSnapshot[]> {
    return Array.from(this.rows.values())
      .filter((r) => r.cohortYearMonth === cohortYearMonth)
      .sort((a, b) => a.monthsElapsed - b.monthsElapsed)
      .map((r) => ({ ...r }));
  }

  async listByCohortRange(fromCohort: string, toCohort: string): Promise<FinanceCohortSnapshot[]> {
    return Array.from(this.rows.values())
      .filter((r) => r.cohortYearMonth >= fromCohort && r.cohortYearMonth <= toCohort)
      .sort((a, b) => (a.cohortYearMonth === b.cohortYearMonth ? a.monthsElapsed - b.monthsElapsed : a.cohortYearMonth < b.cohortYearMonth ? -1 : 1))
      .map((r) => ({ ...r }));
  }

  async upsert(
    cohortYearMonth: string,
    monthsElapsed: number,
    data: { originalCount: number; survivingCount: number },
  ): Promise<FinanceCohortSnapshot> {
    const row: FinanceCohortSnapshot = { cohortYearMonth, monthsElapsed, ...data, computedAt: new Date() };
    this.rows.set(this.key(cohortYearMonth, monthsElapsed), row);
    return { ...row };
  }
}
