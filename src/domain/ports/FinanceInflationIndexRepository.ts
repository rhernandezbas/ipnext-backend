/**
 * finance-growth Fase 2 (design.md Decision 3) — índice IPC mensual cargado a
 * mano: `monthlyRatePct` es la variación mensual TAL CUAL la publica INDEC
 * (ej. `4.2` para +4.2% ese mes), no un índice base-100 precalculado. El
 * encadenamiento (Decision 3: `chainedIndex`) es responsabilidad del
 * consumidor de lectura (`GetFinanceOverview`, Fase 4) — este port solo
 * persiste/lista la serie cruda.
 */
export interface FinanceInflationIndex {
  yearMonth: string;
  monthlyRatePct: number;
  source: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FinanceInflationIndexPatch {
  monthlyRatePct: number;
  source: string | null;
}

export interface FinanceInflationIndexRepository {
  /** Ordenado ASCENDENTE por `yearMonth`. `fromYearMonth`/`toYearMonth` inclusive; omitidos = sin cota en ese extremo. */
  list(fromYearMonth?: string, toYearMonth?: string): Promise<FinanceInflationIndex[]>;
  upsert(yearMonth: string, patch: FinanceInflationIndexPatch): Promise<FinanceInflationIndex>;
}
