import {
  FinanceInflationIndex,
  FinanceInflationIndexPatch,
  FinanceInflationIndexRepository,
} from '@domain/ports/FinanceInflationIndexRepository';
import { compareYearMonth } from '@application/use-cases/finance/financeDates';

/** finance-growth Fase 2 — in-memory test double. */
export class InMemoryFinanceInflationIndexRepository implements FinanceInflationIndexRepository {
  private rows = new Map<string, FinanceInflationIndex>();

  async list(fromYearMonth?: string, toYearMonth?: string): Promise<FinanceInflationIndex[]> {
    return [...this.rows.values()]
      .filter((r) => (fromYearMonth ? compareYearMonth(r.yearMonth, fromYearMonth) >= 0 : true))
      .filter((r) => (toYearMonth ? compareYearMonth(r.yearMonth, toYearMonth) <= 0 : true))
      .map((r) => ({ ...r }))
      .sort((a, b) => compareYearMonth(a.yearMonth, b.yearMonth));
  }

  async upsert(yearMonth: string, patch: FinanceInflationIndexPatch): Promise<FinanceInflationIndex> {
    const existing = this.rows.get(yearMonth);
    const now = new Date();
    const row: FinanceInflationIndex = {
      yearMonth,
      ...patch,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.rows.set(yearMonth, row);
    return { ...row };
  }

  /** Test seam. */
  seed(row: FinanceInflationIndex): void {
    this.rows.set(row.yearMonth, { ...row });
  }
}
