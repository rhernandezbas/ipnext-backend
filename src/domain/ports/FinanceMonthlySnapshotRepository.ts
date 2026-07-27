/**
 * finance-growth Fase 3 REWORK (2026-07-27, "DOS NÚMEROS, DOS PREGUNTAS" —
 * user LOCK decision) — one precomputed row per calendar month.
 *
 * ── THE TWO NUMBERS ──
 *
 * 1. **MRR CONTRATADO** (`mrrInicialArs`..`mrrFinalArs`) = Σ (precio del
 *    plan × contratos activos), derived EXCLUSIVELY from `ContractServiceEvent`
 *    (altas/upgrades/downgrades/bajas) + `FinancePlanPrice`. The bridge runs
 *    over THIS number and closes BY CONSTRUCTION for every contract whose
 *    plan price is resolvable (see `unpricedContractsActive` below for the
 *    honest exception) — because this base, unlike cash, changes ONLY via
 *    those 4 event types. Answers "¿crece la base y su valor?", immune to
 *    payment timing.
 * 2. **COBRANZA REAL** (`revenueTotalArs`) = cash puro (`FinanceReceiptItem`,
 *    por `receipt.fechaRecibo`), NUNCA facturación. Its own series, NO
 *    bridge (mora/pagos adelantados/regularizaciones/inflación break any
 *    4-event decomposition — this was the root finding of the rework).
 *    Answers "¿entró plata?".
 * 3. **TASA DE COBRANZA** (`collectionRatePct`) = cobranza / MRR contratado
 *    del mes — the metric that connects the two numbers. `null` when
 *    `mrrFinalArs` is 0 (no contracted base to compare against — NOT the
 *    same as "0% collected").
 *
 * ── UNPRICED VISIBILITY (F2 — `FinancePlanPrice` is LOAD-BEARING now) ──
 *
 * A contract's price is "unresolvable" when EITHER its plan code can't be
 * derived from `ContractServiceEvent` history (a contract with no 'modified'
 * event ever has `planCode: null` — 'activated' events carry NO plan info in
 * this codebase, a real, documented limitation, see `BuildFinanceMonthlySnapshot`'s
 * docblock) OR the resolved code has no `FinancePlanPrice` row. Either way,
 * that contract contributes **0** to MRR contratado — NEVER silently, always
 * counted in `unpricedContractsActive`/`unpricedContractsPct`. A 'modified'
 * event where either side's price is unresolvable contributes 0 to
 * `mrrUpgradeArs`/`mrrDowngradeArs` (never a wrong 3x-inflated guess) and
 * increments `unpricedPlanChangeEvents`.
 *
 * ── CAPA B (cash attributed to internet contracts) — diagnostic only ──
 *
 * `revenueAttributableArs`/`attributionPct` still exist (spec.md "Two-layer
 * attribution") but now measure the RIGHT population (F6): the cash
 * attributed to ALL internet contracts touched this month — including ones
 * that churned mid-month — never just the population that also survives
 * into `mrrFinalArs` (a DIFFERENT, contracted-MRR concept post-rework).
 *
 * All `*Ars` fields are NOMINAL (never pre-deflacted) — the nominal↔real
 * split happens at READ time in `GetFinanceOverview`, chained from
 * `FinanceInflationIndex` (Decision 3).
 */
export interface FinanceMonthlySnapshot {
  yearMonth: string; // "YYYY-MM"
  contractsActive: number;
  /** Raw count of 'activated'/'reactivated' events this month (activity log — NOT the churn-rate-safe set, see F7/F3 in BuildFinanceMonthlySnapshot). */
  contractsNew: number;
  /** Raw count of 'deactivated' events this month (activity log — see above). */
  contractsChurned: number;
  contractsUpgraded: number;
  contractsDowngraded: number;
  /** MRR CONTRATADO — Σ precio de plan de contratos activos al INICIO del mes (computado fresh cada corrida, nunca encadenado desde el snapshot anterior — ver F4). */
  mrrInicialArs: number;
  mrrNewArs: number;
  /** Delta de precio POSITIVO de 'modified' events (price-sign based, NO kbps-based — ver docblock de BuildFinanceMonthlySnapshot). */
  mrrUpgradeArs: number;
  /** Delta de precio NEGATIVO (valor absoluto) de 'modified' events. */
  mrrDowngradeArs: number;
  mrrChurnArs: number;
  /** mrrInicialArs + mrrNewArs + mrrUpgradeArs − mrrDowngradeArs − mrrChurnArs, EXACTO cuando todos los contratos tocados este mes tienen precio resoluble. */
  mrrFinalArs: number;
  /**
   * fix-wave-3 (🟡 4) — mrrFinalArs − (mrrInicialArs + mrrNewArs + mrrUpgradeArs
   * − mrrDowngradeArs − mrrChurnArs). Es la red de seguridad de TODO lo demás:
   * cuando el bridge cierra por construcción (caso sano) es EXACTAMENTE 0;
   * cuando no cierra (un extremo sin precio, un evento 'modified' perdido por
   * el try/catch best-effort de `ChangePppoePlanService`, o cualquier caso
   * futuro no previsto), este campo hace el hueco VISIBLE en vez de dejarlo
   * como "un número mal en silencio". Antes de este campo, un gap de -15000
   * en un caso sin precio pasaba con `unpricedContractsActive: 0` — ninguna
   * señal apuntaba al problema.
   */
  bridgeResidualArs: number;
  /** Contratos activos al cierre del mes cuyo precio contratado NO pudo resolverse (F2) — excluidos de mrrFinalArs, nunca un cero silencioso. */
  unpricedContractsActive: number;
  /** unpricedContractsActive / contractsActive * 100 (0 si contractsActive es 0). */
  unpricedContractsPct: number;
  /** 'modified' events este mes donde el precio viejo O nuevo era irresoluble — excluidos de mrrUpgradeArs/mrrDowngradeArs (F2), nunca absorbidos como si el lado faltante valiera 0. */
  unpricedPlanChangeEvents: number;
  /**
   * fix-wave-3 (🔴 1) — 'modified' events este mes donde el plan viejo O
   * nuevo es un código de ENFORCEMENT (`IP-REDUCCION`/`IP-BAJA`,
   * `isEnforcementPlan`) — excluidos de mrrUpgradeArs/mrrDowngradeArs (nunca
   * tratados como un cambio comercial real, aunque el código tenga una fila
   * en `FinancePlanPrice`), y contados acá en vez de silenciosamente. Estos
   * códigos son reservados por el orchestrator para cortes/reducciones por
   * mora — un cambio de plan que aterriza en uno de ellos (vía un
   * `ChangePppoePlanService` manual que bypasea reduce/restore) NUNCA es la
   * intención comercial real del contrato. Semánticamente distinto de
   * `unpricedPlanChangeEvents`: acá el precio SÍ puede ser resoluble, la
   * exclusión es por SER un código de enforcement, no por falta de precio.
   */
  enforcementPlanChangeEventsExcluded: number;
  /** COBRANZA REAL — Capa A, cash puro del mes (FinanceReceiptItem, por receipt.fechaRecibo), TODO el universo (no sólo clientes de internet). NUNCA facturación emitida. */
  revenueTotalArs: number;
  /** TASA DE COBRANZA — revenueTotalArs / mrrFinalArs * 100. `null` cuando mrrFinalArs es 0 (sin base contratada contra la cual comparar — no es "0% cobrado"). */
  collectionRatePct: number | null;
  /** Capa B — suma de contratos con attributionConfidence 'exact', sobre la población de TODOS los contratos de internet tocados este mes (F6). */
  revenueAttributableArs: number;
  /** Suma de aplicaciones (Capa A, FinanceReceiptApplication) de grType sin clasificar — nunca se pierde en silencio. */
  unclassifiedAmountArs: number;
  /** (MRR 'exact' / MRR total atribuido a internet este mes) * 100 — población corregida en F6 (incluye bajas del mes). */
  attributionPct: number;
  /** Cash (Capa B, todas las confianzas) atribuido a contratos de internet activos al CIERRE del mes / contractsActive — nunca mezclado con revenueTotalArs (F5). */
  arpuArs: number;
  /** (bajas ∩ activos-al-inicio ∩ NO activos-al-cierre) / activos-al-inicio * 100 — excluye alta+baja mismo mes (F3) y baja+re-alta mismo mes (F7). */
  churnContractsPct: number;
  /** mrrChurnArs / mrrInicialArs * 100. `null` cuando no había ningún contrato activo al inicio del mes (sin base — no es "0% de churn de ingresos", ver F4). */
  churnRevenuePct: number | null;
  computedAt: Date;
}

export type FinanceMonthlySnapshotUpsert = Omit<FinanceMonthlySnapshot, 'computedAt'>;

export interface FinanceMonthlySnapshotRepository {
  get(yearMonth: string): Promise<FinanceMonthlySnapshot | null>;
  /** Inclusive range, ordered ASCENDING by yearMonth. */
  listRange(fromYearMonth: string, toYearMonth: string): Promise<FinanceMonthlySnapshot[]>;
  /** Idempotent upsert keyed by `yearMonth` — a re-run overwrites the whole row (never a partial merge). */
  upsert(yearMonth: string, data: Omit<FinanceMonthlySnapshotUpsert, 'yearMonth'>): Promise<FinanceMonthlySnapshot>;
}
