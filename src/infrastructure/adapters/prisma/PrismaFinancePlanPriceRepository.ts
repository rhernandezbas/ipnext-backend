import {
  FinancePlanPrice,
  FinancePlanPricePatch,
  FinancePlanPriceRepository,
} from '@domain/ports/FinancePlanPriceRepository';
import { prisma } from '../../database/prisma';

interface PriceRow {
  planCode: string;
  estimatedMonthlyPrice: unknown; // Prisma.Decimal
  updatedByUserId: string | null;
  updatedAt: Date;
}

function toEntity(row: PriceRow): FinancePlanPrice {
  return {
    planCode: row.planCode,
    estimatedMonthlyPrice: Number(row.estimatedMonthlyPrice),
    updatedByUserId: row.updatedByUserId,
    updatedAt: row.updatedAt,
  };
}

/** finance-growth Fase 2 — Prisma adapter for `FinancePlanPrice`, keyed by `planCode`. */
export class PrismaFinancePlanPriceRepository implements FinancePlanPriceRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get table(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).financePlanPrice;
  }

  async list(): Promise<FinancePlanPrice[]> {
    const rows: PriceRow[] = await this.table.findMany({ orderBy: { planCode: 'asc' } });
    return rows.map(toEntity);
  }

  async getByPlanCode(planCode: string): Promise<FinancePlanPrice | null> {
    const row: PriceRow | null = await this.table.findUnique({ where: { planCode } });
    return row ? toEntity(row) : null;
  }

  async upsert(planCode: string, patch: FinancePlanPricePatch): Promise<FinancePlanPrice> {
    const row: PriceRow = await this.table.upsert({
      where: { planCode },
      create: { planCode, ...patch },
      update: { ...patch },
    });
    return toEntity(row);
  }
}
