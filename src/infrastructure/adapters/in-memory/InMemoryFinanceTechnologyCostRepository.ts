import {
  FinanceTechnologyCost,
  FinanceTechnologyCostPatch,
  FinanceTechnologyCostRepository,
} from '@domain/ports/FinanceTechnologyCostRepository';

/** finance-growth Fase 2 — in-memory test double (molde `InMemoryFinanceInvoiceTypeClassificationRepository`). */
export class InMemoryFinanceTechnologyCostRepository implements FinanceTechnologyCostRepository {
  private rows = new Map<string, FinanceTechnologyCost>();

  async list(): Promise<FinanceTechnologyCost[]> {
    return [...this.rows.values()].map((r) => ({ ...r })).sort((a, b) => a.technologyName.localeCompare(b.technologyName));
  }

  async getByTechnology(technologyName: string): Promise<FinanceTechnologyCost | null> {
    const row = this.rows.get(technologyName);
    return row ? { ...row } : null;
  }

  async upsert(technologyName: string, patch: FinanceTechnologyCostPatch): Promise<FinanceTechnologyCost> {
    const row: FinanceTechnologyCost = { technologyName, ...patch, updatedAt: new Date() };
    this.rows.set(technologyName, row);
    return { ...row };
  }

  /** Test seam. */
  seed(row: FinanceTechnologyCost): void {
    this.rows.set(row.technologyName, { ...row });
  }
}
