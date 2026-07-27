import {
  FinanceCohortSnapshot,
  FinanceCohortSnapshotRepository,
} from '@domain/ports/FinanceCohortSnapshotRepository';
import { prisma } from '../../database/prisma';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toEntity(row: any): FinanceCohortSnapshot {
  return {
    cohortYearMonth: row.cohortYearMonth,
    monthsElapsed: row.monthsElapsed,
    originalCount: row.originalCount,
    survivingCount: row.survivingCount,
    computedAt: row.computedAt,
  };
}

/** finance-growth Fase 3 — Prisma adapter for `FinanceCohortSnapshot`, keyed by the composite `(cohortYearMonth, monthsElapsed)`. */
export class PrismaFinanceCohortSnapshotRepository implements FinanceCohortSnapshotRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get table(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).financeCohortSnapshot;
  }

  async listByCohort(cohortYearMonth: string): Promise<FinanceCohortSnapshot[]> {
    const rows = await this.table.findMany({
      where: { cohortYearMonth },
      orderBy: { monthsElapsed: 'asc' },
    });
    return rows.map(toEntity);
  }

  async upsert(
    cohortYearMonth: string,
    monthsElapsed: number,
    data: { originalCount: number; survivingCount: number },
  ): Promise<FinanceCohortSnapshot> {
    const payload = { originalCount: data.originalCount, survivingCount: data.survivingCount, computedAt: new Date() };
    const row = await this.table.upsert({
      where: { cohortYearMonth_monthsElapsed: { cohortYearMonth, monthsElapsed } },
      create: { cohortYearMonth, monthsElapsed, ...payload },
      update: payload,
    });
    return toEntity(row);
  }
}
