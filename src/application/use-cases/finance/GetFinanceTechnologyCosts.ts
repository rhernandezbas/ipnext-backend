import { FinanceTechnologyCostRepository } from '@domain/ports/FinanceTechnologyCostRepository';
import { ContractTechnologyRepository } from '@domain/ports/ContractTechnologyRepository';

/**
 * View row for `GET /api/finance/growth/config/technology-costs` — the LEFT
 * JOIN result (design.md "GET /config/technology-costs"). `updatedAt: null`
 * means "never configured" (defaults in 0), distinct from the domain entity
 * `FinanceTechnologyCost` (which always has a real `updatedAt` once a row
 * exists).
 */
export interface FinanceTechnologyCostView {
  technologyName: string;
  costoVentaArs: number;
  costoInstalacionArs: number;
  costoMensualServicioArs: number;
  comisionVentaPct: number;
  updatedAt: Date | null;
}

/**
 * finance-growth Fase 2 (spec.md "A new technology with no configured cost
 * defaults to zero, never crashes") — LEFT JOINs `ContractTechnologyRepository.list()`
 * (the authoritative catalog of technologies) against `FinanceTechnologyCostRepository`
 * (the settable costs, which may not have a row yet for every technology).
 * The technology catalog drives the row set — a technology is NEVER omitted
 * for lacking a configured cost.
 */
export class GetFinanceTechnologyCosts {
  constructor(
    private readonly costs: FinanceTechnologyCostRepository,
    private readonly technologies: ContractTechnologyRepository,
  ) {}

  async execute(): Promise<FinanceTechnologyCostView[]> {
    const [technologies, costRows] = await Promise.all([this.technologies.list(), this.costs.list()]);
    const costByName = new Map(costRows.map((c) => [c.technologyName, c]));

    return technologies.map((tech) => {
      const cost = costByName.get(tech.name);
      return cost
        ? {
            technologyName: tech.name,
            costoVentaArs: cost.costoVentaArs,
            costoInstalacionArs: cost.costoInstalacionArs,
            costoMensualServicioArs: cost.costoMensualServicioArs,
            comisionVentaPct: cost.comisionVentaPct,
            updatedAt: cost.updatedAt,
          }
        : {
            technologyName: tech.name,
            costoVentaArs: 0,
            costoInstalacionArs: 0,
            costoMensualServicioArs: 0,
            comisionVentaPct: 0,
            updatedAt: null,
          };
    });
  }
}
