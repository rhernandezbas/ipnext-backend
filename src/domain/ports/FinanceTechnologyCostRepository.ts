/**
 * finance-growth Fase 2 (design.md Data Model) — costo por tecnología, una
 * fila por `ContractTechnology.name` (clave natural, sin FK — deuda declarada
 * #2 del design). `comisionVentaPct` viaja en esta misma fila (decisión
 * declarada del change: la comisión de venta va POR TECNOLOGÍA, igual que el
 * resto de los costos — no por plan ni global).
 */
export interface FinanceTechnologyCost {
  technologyName: string;
  costoVentaArs: number;
  costoInstalacionArs: number;
  costoMensualServicioArs: number;
  /** % del abono, 0-100. */
  comisionVentaPct: number;
  updatedByUserId: string | null;
  updatedAt: Date;
}

export interface FinanceTechnologyCostPatch {
  costoVentaArs: number;
  costoInstalacionArs: number;
  costoMensualServicioArs: number;
  comisionVentaPct: number;
  updatedByUserId: string | null;
}

export interface FinanceTechnologyCostRepository {
  list(): Promise<FinanceTechnologyCost[]>;
  getByTechnology(technologyName: string): Promise<FinanceTechnologyCost | null>;
  /** Upsert keyed by `technologyName`. Full-row replace (no partial merge — the use case validates the whole payload before calling this). */
  upsert(technologyName: string, patch: FinanceTechnologyCostPatch): Promise<FinanceTechnologyCost>;
}
