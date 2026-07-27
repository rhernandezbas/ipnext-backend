import {
  FinanceInflationIndex,
  FinanceInflationIndexPatch,
  FinanceInflationIndexRepository,
} from '@domain/ports/FinanceInflationIndexRepository';
import { prisma } from '../../database/prisma';

interface IndexRow {
  yearMonth: string;
  monthlyRatePct: unknown; // Prisma.Decimal
  source: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toEntity(row: IndexRow): FinanceInflationIndex {
  return {
    yearMonth: row.yearMonth,
    monthlyRatePct: Number(row.monthlyRatePct),
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * finance-growth Fase 2 (design.md Decision 3) — Prisma adapter for the IPC
 * series. `yearMonth` is a fixed-width zero-padded "YYYY-MM" string, so a
 * plain string `gte`/`lte` on it sorts/filters correctly without a
 * dedicated date column (same trick as `isValidYearMonth`/`compareYearMonth`).
 */
export class PrismaFinanceInflationIndexRepository implements FinanceInflationIndexRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get table(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).financeInflationIndex;
  }

  async list(fromYearMonth?: string, toYearMonth?: string): Promise<FinanceInflationIndex[]> {
    const yearMonth: Record<string, string> = {};
    if (fromYearMonth) yearMonth['gte'] = fromYearMonth;
    if (toYearMonth) yearMonth['lte'] = toYearMonth;
    const rows: IndexRow[] = await this.table.findMany({
      where: Object.keys(yearMonth).length > 0 ? { yearMonth } : undefined,
      orderBy: { yearMonth: 'asc' },
    });
    return rows.map(toEntity);
  }

  async upsert(yearMonth: string, patch: FinanceInflationIndexPatch): Promise<FinanceInflationIndex> {
    const row: IndexRow = await this.table.upsert({
      where: { yearMonth },
      create: { yearMonth, ...patch },
      update: { ...patch },
    });
    return toEntity(row);
  }
}
