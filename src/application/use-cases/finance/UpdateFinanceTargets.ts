import { FinanceTargetsConfig, FinanceTargetsConfigRepository } from '@domain/ports/FinanceTargetsConfigRepository';
import { FinanceValidationError } from '@domain/errors/finance';
import { isValidYearMonth } from './financeDates';
import { assertDecimalBounds, assertInt32Range, roundToScale } from './financeDecimal';

export type UpdateFinanceTargetsInput = FinanceTargetsConfig;

/** Schema: `churnTargetPct Decimal(5,2)`; `maxPaybackMonths`/`monthlyNewContractsGoal Int` (32-bit). */
const PCT_PRECISION = 5;
const PCT_SCALE = 2;

/**
 * finance-growth Fase 2 (spec.md "rechaza `churnTargetPct` fuera de 0-100, o
 * `inflationBaseYearMonth` con formato inválido (ni `""` ni `YYYY-MM`), sin
 * actualización parcial"). The whole payload is validated BEFORE calling
 * `repo.update` — a rejected PUT never touches the singleton row.
 *
 * fix-wave-1 A (converged, both reviewers) — `maxPaybackMonths`/
 * `monthlyNewContractsGoal` are Postgres 32-bit `Int`; a value beyond that
 * range (e.g. a stray `1e10`) reached `repo.update` and raised a raw
 * "integer out of range" error against real Postgres, which `errorHandler`
 * can't map to a `DomainError` → opaque 500. `churnTargetPct` also gets the
 * schema's `Decimal(5,2)` bound (looser than the 0-100 business rule above,
 * kept for defense-in-depth/consistency with the other settables) and is
 * rounded to the column's scale so the in-memory double and Postgres agree.
 */
export class UpdateFinanceTargets {
  constructor(private readonly repo: FinanceTargetsConfigRepository) {}

  async execute(input: UpdateFinanceTargetsInput): Promise<FinanceTargetsConfig> {
    if (typeof input.churnTargetPct !== 'number' || !Number.isFinite(input.churnTargetPct) || input.churnTargetPct < 0 || input.churnTargetPct > 100) {
      throw new FinanceValidationError('churnTargetPct must be a number between 0 and 100');
    }
    assertDecimalBounds(input.churnTargetPct, 'churnTargetPct', PCT_PRECISION, PCT_SCALE);
    // fix-wave-4 🔵15 — `>= 1`, not `>= 0`: a 0-month payback window is not a
    // real business value. It degenerates `RankEarlyChurnByVendor`'s
    // "temprano" cutoff to the alta instant itself (an empty window, every
    // alta trivially "matures" instantly) and `ComputeCacAndPayback`'s
    // `lossMaking` threshold to "any payback at all is loss-making" —
    // closed at the source instead of leaving every consumer to guard it.
    if (!Number.isInteger(input.maxPaybackMonths) || input.maxPaybackMonths < 1) {
      throw new FinanceValidationError('maxPaybackMonths must be a positive integer (>= 1)');
    }
    assertInt32Range(input.maxPaybackMonths, 'maxPaybackMonths');
    if (!Number.isInteger(input.monthlyNewContractsGoal) || input.monthlyNewContractsGoal < 0) {
      throw new FinanceValidationError('monthlyNewContractsGoal must be a non-negative integer');
    }
    assertInt32Range(input.monthlyNewContractsGoal, 'monthlyNewContractsGoal');
    if (input.inflationBaseYearMonth !== '' && !isValidYearMonth(input.inflationBaseYearMonth)) {
      throw new FinanceValidationError('inflationBaseYearMonth must be "" or a valid "YYYY-MM"');
    }

    return this.repo.update({
      churnTargetPct: roundToScale(input.churnTargetPct, PCT_SCALE),
      maxPaybackMonths: input.maxPaybackMonths,
      monthlyNewContractsGoal: input.monthlyNewContractsGoal,
      inflationBaseYearMonth: input.inflationBaseYearMonth,
    });
  }
}
