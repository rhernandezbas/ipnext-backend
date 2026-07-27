import {
  FinanceMonthlySnapshot,
  FinanceMonthlySnapshotRepository,
  FinanceMonthlySnapshotUpsert,
} from '@domain/ports/FinanceMonthlySnapshotRepository';
import { compareYearMonth } from '@application/use-cases/finance/financeDates';

export class InMemoryFinanceMonthlySnapshotRepository implements FinanceMonthlySnapshotRepository {
  rows = new Map<string, FinanceMonthlySnapshot>();

  async get(yearMonth: string): Promise<FinanceMonthlySnapshot | null> {
    const row = this.rows.get(yearMonth);
    return row ? { ...row } : null;
  }

  async listRange(fromYearMonth: string, toYearMonth: string): Promise<FinanceMonthlySnapshot[]> {
    return Array.from(this.rows.values())
      .filter((r) => compareYearMonth(r.yearMonth, fromYearMonth) >= 0 && compareYearMonth(r.yearMonth, toYearMonth) <= 0)
      .sort((a, b) => compareYearMonth(a.yearMonth, b.yearMonth))
      .map((r) => ({ ...r }));
  }

  async upsert(
    yearMonth: string,
    data: Omit<FinanceMonthlySnapshotUpsert, 'yearMonth'>,
  ): Promise<FinanceMonthlySnapshot> {
    const row: FinanceMonthlySnapshot = { ...data, yearMonth, computedAt: new Date() };
    this.rows.set(yearMonth, row);
    return { ...row };
  }
}
