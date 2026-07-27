import { FinancePlanPrice, FinancePlanPriceRepository } from '@domain/ports/FinancePlanPriceRepository';
import { PlanRepository } from '@domain/ports/PlanRepository';
import { FinancePlanNotFoundError, FinanceValidationError } from '@domain/errors/finance';
import { assertDecimalBounds, roundToScale } from './financeDecimal';

export interface UpdateFinancePlanPriceInput {
  estimatedMonthlyPrice: number;
}

/**
 * fix-wave-1 LOW F — the PUT response used to omit `planName` (the settable
 * `FinancePlanPrice` row doesn't carry it), an asymmetry with every other
 * settable's PUT response (which echoes the full DTO). A FE patching its
 * local row with this response left `planName` `undefined` until the next
 * GET. The use case already fetches the catalog `plan` for the D existence
 * guard, so surfacing `plan.name` here is free — no second lookup.
 */
export interface UpdateFinancePlanPriceResult extends FinancePlanPrice {
  planName: string;
}

/** Schema: `estimatedMonthlyPrice Decimal(12,2)` (prisma/schema.prisma). */
const PRICE_PRECISION = 12;
const PRICE_SCALE = 2;

/**
 * finance-growth Fase 2 (spec.md "Technology, plan, target and inflation
 * values are editable ...").
 *
 * fix-wave-1 D — `planCode` must exist in the `Plan` catalog BEFORE the
 * upsert, same rationale as `UpdateFinanceTechnologyCost` (see
 * `FinancePlanNotFoundError` docblock): a typo'd/retired code otherwise
 * upserts a silent orphan `GetFinancePlanPrices`'s catalog-driven LEFT JOIN
 * never surfaces.
 *
 * fix-wave-1 A — cota de precisión derivada del schema (`Decimal(12,2)`) +
 * redondeo explícito a la escala de columna antes de persistir (ver
 * `financeDecimal.ts`).
 */
export class UpdateFinancePlanPrice {
  constructor(
    private readonly repo: FinancePlanPriceRepository,
    private readonly plans: PlanRepository,
  ) {}

  async execute(planCode: string, input: UpdateFinancePlanPriceInput, actorUserId: string): Promise<UpdateFinancePlanPriceResult> {
    const plan = await this.plans.findByCode(planCode);
    if (!plan) {
      throw new FinancePlanNotFoundError(planCode);
    }

    if (typeof input.estimatedMonthlyPrice !== 'number' || !Number.isFinite(input.estimatedMonthlyPrice)) {
      throw new FinanceValidationError('estimatedMonthlyPrice must be a finite number');
    }
    if (input.estimatedMonthlyPrice < 0) {
      throw new FinanceValidationError('estimatedMonthlyPrice must be >= 0');
    }
    assertDecimalBounds(input.estimatedMonthlyPrice, 'estimatedMonthlyPrice', PRICE_PRECISION, PRICE_SCALE);

    const persisted = await this.repo.upsert(plan.code, {
      estimatedMonthlyPrice: roundToScale(input.estimatedMonthlyPrice, PRICE_SCALE),
      updatedByUserId: actorUserId,
    });
    return { ...persisted, planName: plan.name };
  }
}
