/**
 * finance-growth Fase 2 (design.md Data Model) — precio mensual ESTIMADO por
 * plan, una fila por `Plan.code` (clave natural, sin FK). Uso EXCLUSIVO:
 * criterio de reparto proporcional de la atribución Capa B (Decision 1) y el
 * "what-if" de CAC/payback para planes sin historial de ventas todavía —
 * NUNCA la fuente de la cobranza agregada (esa siempre es Capa A, cobranza
 * real vía `FinanceReceiptItem`).
 */
export interface FinancePlanPrice {
  planCode: string;
  estimatedMonthlyPrice: number;
  updatedByUserId: string | null;
  updatedAt: Date;
}

export interface FinancePlanPricePatch {
  estimatedMonthlyPrice: number;
  updatedByUserId: string | null;
}

export interface FinancePlanPriceRepository {
  list(): Promise<FinancePlanPrice[]>;
  getByPlanCode(planCode: string): Promise<FinancePlanPrice | null>;
  /** Upsert keyed by `planCode`. */
  upsert(planCode: string, patch: FinancePlanPricePatch): Promise<FinancePlanPrice>;
}
