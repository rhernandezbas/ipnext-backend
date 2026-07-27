/**
 * finance-growth Fase 2 (design.md Data Model) — metas y config global,
 * molde singleton (mismo criterio que `FinanceReceiptSyncConfig`).
 * `inflationBaseYearMonth: ""` significa "sin configurar" (la serie real de
 * `GetFinanceOverview` no está disponible hasta que se cargue un mes ancla).
 */
export interface FinanceTargetsConfig {
  churnTargetPct: number;
  maxPaybackMonths: number;
  monthlyNewContractsGoal: number;
  /** "" = sin configurar; en caso contrario, "YYYY-MM". */
  inflationBaseYearMonth: string;
}

export type FinanceTargetsConfigPatch = FinanceTargetsConfig;

export interface FinanceTargetsConfigRepository {
  /** Devuelve la fila singleton; si nunca se editó, devuelve los defaults seedeados por la migración. */
  get(): Promise<FinanceTargetsConfig>;
  update(patch: FinanceTargetsConfigPatch): Promise<FinanceTargetsConfig>;
}

/** Defaults reflejados en el seed de la migración (design.md Data Model). */
export const FINANCE_TARGETS_CONFIG_DEFAULTS: FinanceTargetsConfig = {
  churnTargetPct: 5,
  maxPaybackMonths: 12,
  monthlyNewContractsGoal: 0,
  inflationBaseYearMonth: '',
};
