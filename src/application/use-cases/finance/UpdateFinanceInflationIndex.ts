import { FinanceInflationIndex, FinanceInflationIndexRepository } from '@domain/ports/FinanceInflationIndexRepository';
import { FinanceValidationError } from '@domain/errors/finance';
import { isValidYearMonth } from './financeDates';
import { assertDecimalBounds, roundToScale } from './financeDecimal';

export interface UpdateFinanceInflationIndexInput {
  monthlyRatePct: number;
  source?: string | null;
}

/** Schema: `monthlyRatePct Decimal(6,3)` (prisma/schema.prisma) → max magnitude 999.999. */
const RATE_PRECISION = 6;
const RATE_SCALE = 3;

/**
 * finance-growth Fase 2 (spec.md "rechaza `yearMonth` con formato inválido en
 * el path, y `monthlyRatePct` no numérico, sin persistir" — task 2.30). The
 * IPC series feeds `GetFinanceOverview`'s deflactación (design.md Decision 3)
 * — a malformed month or a non-numeric rate must NEVER reach the table, since
 * a bad value here silently corrupts every "real" figure downstream.
 *
 * fix-wave-1 A (converged, both reviewers) — the realistic trigger: an
 * operator pastes the INDEC INDEX or the annual accumulated rate instead of
 * the MONTHLY rate (e.g. `42000`, `1500`). `Decimal(6,3)` can only hold
 * magnitudes `< 1000` — without this bound, that value reached
 * `repo.upsert` and a real Postgres raised a raw numeric-overflow error
 * `errorHandler` can't map to a `DomainError`, surfacing as an opaque 500.
 * Also rounds to the column's scale (3 decimals) explicitly so the
 * in-memory double and Postgres agree on the observable value.
 */
export class UpdateFinanceInflationIndex {
  constructor(private readonly repo: FinanceInflationIndexRepository) {}

  async execute(yearMonth: string, input: UpdateFinanceInflationIndexInput): Promise<FinanceInflationIndex> {
    if (!isValidYearMonth(yearMonth)) {
      throw new FinanceValidationError('yearMonth must be a valid "YYYY-MM"');
    }
    if (typeof input.monthlyRatePct !== 'number' || !Number.isFinite(input.monthlyRatePct)) {
      throw new FinanceValidationError('monthlyRatePct must be a finite number');
    }
    assertDecimalBounds(input.monthlyRatePct, 'monthlyRatePct', RATE_PRECISION, RATE_SCALE);

    return this.repo.upsert(yearMonth, {
      monthlyRatePct: roundToScale(input.monthlyRatePct, RATE_SCALE),
      source: input.source ?? null,
    });
  }
}
