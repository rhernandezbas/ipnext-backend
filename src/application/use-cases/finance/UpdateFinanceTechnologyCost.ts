import { FinanceTechnologyCost, FinanceTechnologyCostRepository } from '@domain/ports/FinanceTechnologyCostRepository';
import { ContractTechnologyRepository } from '@domain/ports/ContractTechnologyRepository';
import { FinanceTechnologyNotFoundError, FinanceValidationError } from '@domain/errors/finance';
import { assertDecimalBounds, roundToScale } from './financeDecimal';

export interface UpdateFinanceTechnologyCostInput {
  costoVentaArs: number;
  costoInstalacionArs: number;
  costoMensualServicioArs: number;
  comisionVentaPct: number;
}

/** Schema: `Decimal(12,2)` for the 3 ARS costs, `Decimal(5,2)` for the pct (prisma/schema.prisma). */
const ARS_COST_PRECISION = { precision: 12, scale: 2 };
const PCT_PRECISION = { precision: 5, scale: 2 };

/**
 * finance-growth Fase 2 (spec.md "Technology, plan, target and inflation
 * values are editable ..." + "A negative cost value is rejected without
 * partial update") — validates the WHOLE payload BEFORE ever calling
 * `repo.upsert`, so a rejected PUT NEVER touches any field of the existing
 * row, valid ones included (task 2.8).
 *
 * fix-wave-1 D — `technologyName` must exist in the `ContractTechnology`
 * catalog BEFORE the upsert: writing a typo'd/renamed name silently created
 * an orphan row `GetFinanceTechnologyCosts`'s catalog-driven LEFT JOIN would
 * NEVER surface (see `FinanceTechnologyNotFoundError` docblock). The upsert
 * key is `tech.name` (the catalog's canonical casing), never the raw path
 * param — `getByName` is case-insensitive, so this also prevents a second,
 * case-variant row for the same technology.
 *
 * fix-wave-1 A — cotas de precisión derivadas del schema (`Decimal(12,2)` /
 * `Decimal(5,2)`), y redondeo explícito a la escala de columna ANTES de
 * persistir, para que el doble in-memory y Prisma/Postgres coincidan en el
 * valor observable ante el mismo input (ver `financeDecimal.ts`).
 */
export class UpdateFinanceTechnologyCost {
  constructor(
    private readonly repo: FinanceTechnologyCostRepository,
    private readonly technologies: ContractTechnologyRepository,
  ) {}

  async execute(
    technologyName: string,
    input: UpdateFinanceTechnologyCostInput,
    actorUserId: string,
  ): Promise<FinanceTechnologyCost> {
    const tech = await this.technologies.getByName(technologyName);
    if (!tech) {
      throw new FinanceTechnologyNotFoundError(technologyName);
    }

    assertFiniteNonNegative(input.costoVentaArs, 'costoVentaArs');
    assertDecimalBounds(input.costoVentaArs, 'costoVentaArs', ARS_COST_PRECISION.precision, ARS_COST_PRECISION.scale);
    assertFiniteNonNegative(input.costoInstalacionArs, 'costoInstalacionArs');
    assertDecimalBounds(input.costoInstalacionArs, 'costoInstalacionArs', ARS_COST_PRECISION.precision, ARS_COST_PRECISION.scale);
    assertFiniteNonNegative(input.costoMensualServicioArs, 'costoMensualServicioArs');
    assertDecimalBounds(input.costoMensualServicioArs, 'costoMensualServicioArs', ARS_COST_PRECISION.precision, ARS_COST_PRECISION.scale);
    assertFiniteNonNegative(input.comisionVentaPct, 'comisionVentaPct');
    assertDecimalBounds(input.comisionVentaPct, 'comisionVentaPct', PCT_PRECISION.precision, PCT_PRECISION.scale);
    if (input.comisionVentaPct > 100) {
      throw new FinanceValidationError('comisionVentaPct must be <= 100');
    }

    return this.repo.upsert(tech.name, {
      costoVentaArs: roundToScale(input.costoVentaArs, ARS_COST_PRECISION.scale),
      costoInstalacionArs: roundToScale(input.costoInstalacionArs, ARS_COST_PRECISION.scale),
      costoMensualServicioArs: roundToScale(input.costoMensualServicioArs, ARS_COST_PRECISION.scale),
      comisionVentaPct: roundToScale(input.comisionVentaPct, PCT_PRECISION.scale),
      updatedByUserId: actorUserId,
    });
  }
}

function assertFiniteNonNegative(value: number, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new FinanceValidationError(`${field} must be a finite number`);
  }
  if (value < 0) {
    throw new FinanceValidationError(`${field} must be >= 0`);
  }
}
