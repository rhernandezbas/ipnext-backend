import { FinancePlanPriceRepository } from '@domain/ports/FinancePlanPriceRepository';
import { PlanRepository } from '@domain/ports/PlanRepository';
import { naturalCompare } from '@application/utils/naturalSort';

/** View row for `GET /api/finance/growth/config/plan-prices` (design.md). */
export interface FinancePlanPriceView {
  planCode: string;
  planName: string;
  estimatedMonthlyPrice: number;
  updatedAt: Date | null;
}

/**
 * finance-growth Fase 2 — LEFT JOINs `PlanRepository.list()` (authoritative
 * plan catalog) against `FinancePlanPriceRepository` (the settable estimated
 * price). A plan without a configured price row is NEVER omitted — it
 * appears with `estimatedMonthlyPrice: 0` (same criterion as
 * `GetFinanceTechnologyCosts`).
 *
 * fix-wave-1 LOW E — `PlanRepository.list()`'s docblock is explicit: order is
 * NOT guaranteed (Prisma: DB heap order, which reshuffles after an `UPDATE`;
 * in-memory: insertion order). `GetFinanceTechnologyCosts` gets away without
 * sorting because its `ContractTechnologyRepository.list()` already returns
 * `orderBy: name asc` — this port makes no such promise, so (same criterion
 * as `ListPlans`) the use case sorts explicitly, by `planCode` with the same
 * natural-sort comparator the plan catalog UI uses elsewhere.
 */
export class GetFinancePlanPrices {
  constructor(
    private readonly prices: FinancePlanPriceRepository,
    private readonly plans: PlanRepository,
  ) {}

  async execute(): Promise<FinancePlanPriceView[]> {
    const [plans, priceRows] = await Promise.all([this.plans.list(), this.prices.list()]);
    const priceByCode = new Map(priceRows.map((p) => [p.planCode, p]));

    return plans
      .map((plan) => {
        const price = priceByCode.get(plan.code);
        return {
          planCode: plan.code,
          planName: plan.name,
          estimatedMonthlyPrice: price?.estimatedMonthlyPrice ?? 0,
          updatedAt: price?.updatedAt ?? null,
        };
      })
      .sort((a, b) => naturalCompare(a.planCode, b.planCode));
  }
}
