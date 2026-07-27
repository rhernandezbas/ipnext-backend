import {
  FinancePlanPrice,
  FinancePlanPricePatch,
  FinancePlanPriceRepository,
} from '@domain/ports/FinancePlanPriceRepository';

/** finance-growth Fase 2 — in-memory test double. */
export class InMemoryFinancePlanPriceRepository implements FinancePlanPriceRepository {
  private rows = new Map<string, FinancePlanPrice>();

  async list(): Promise<FinancePlanPrice[]> {
    return [...this.rows.values()].map((r) => ({ ...r })).sort((a, b) => a.planCode.localeCompare(b.planCode));
  }

  async getByPlanCode(planCode: string): Promise<FinancePlanPrice | null> {
    const row = this.rows.get(planCode);
    return row ? { ...row } : null;
  }

  async upsert(planCode: string, patch: FinancePlanPricePatch): Promise<FinancePlanPrice> {
    const row: FinancePlanPrice = { planCode, ...patch, updatedAt: new Date() };
    this.rows.set(planCode, row);
    return { ...row };
  }

  /** Test seam. */
  seed(row: FinancePlanPrice): void {
    this.rows.set(row.planCode, { ...row });
  }
}
