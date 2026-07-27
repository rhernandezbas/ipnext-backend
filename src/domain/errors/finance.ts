import { DomainError } from './index';

/**
 * finance-growth Fase 1 (fix-wave-3 R10) — thrown when a LOAD-BEARING
 * distributed-lock acquisition stays busy for the whole retry budget.
 * `RearmFinanceReceiptsBackfill` is the ONLY current thrower: it and a
 * concurrent scheduler tick write the SAME `cursor` column (`SyncStateRepository`
 * gotcha — they do NOT touch disjoint columns, only the lock keeps them from
 * racing), so losing this race can silently rewind the backfill cursor —
 * never safe to proceed unlocked. Contrast `ForceFinanceDeltaRun`, whose lock
 * is best-effort (its write is a targeted single-column update, immune to
 * ordering — R2) and therefore proceeds WITHOUT throwing when the lock stays
 * busy, instead of using this error.
 *
 * Mapped to HTTP 503 + a `Retry-After` header (never a bare 500) by
 * `errorHandler` — a lock held by a SIBLING request/tick is a transient,
 * retriable condition, not a bug, and the budget (sized to the MEASURED tick
 * hold, R10) means it clears itself shortly.
 */
export class FinanceSyncLockBusyError extends DomainError {
  constructor(
    public readonly lockKey: string,
    public readonly retryAfterSeconds: number,
  ) {
    super(`Lock "${lockKey}" is busy — retry after ~${retryAfterSeconds}s`, 'FINANCE_SYNC_LOCK_BUSY');
    this.name = 'FinanceSyncLockBusyError';
  }
}

/**
 * finance-growth Fase 2 — thrown by the config settables' Update* use cases
 * (`UpdateFinanceTechnologyCost`, `UpdateFinancePlanPrice`, `UpdateFinanceTargets`,
 * `UpdateFinanceInflationIndex`) when the payload violates a business
 * invariant (negative cost, `comisionVentaPct > 100`, malformed `YYYY-MM`,
 * non-numeric rate, ...). Validation happens BEFORE any repository call — no
 * field of the row is ever touched on a rejected payload (spec.md "sin
 * aplicar actualizaciones parciales"). Not in `errorHandler`'s explicit
 * `statusMap` — falls through to the map's default of `400`, exactly right
 * for a client-payload validation error.
 */
export class FinanceValidationError extends DomainError {
  constructor(message: string) {
    super(message, 'FINANCE_VALIDATION_ERROR');
    this.name = 'FinanceValidationError';
  }
}

/**
 * finance-growth Fase 2 fix-wave-1 (finding D) — thrown by
 * `UpdateFinanceTechnologyCost` when `technologyName` doesn't match any row
 * in the `ContractTechnology` catalog (`ContractTechnologyRepository.getByName`).
 * Before this guard, a typo (or a technology renamed via
 * `PUT /api/contract-technologies/:id` AFTER its costs were configured — the
 * natural-key join has no FK, deuda #2) upserted a silent ORPHAN row: the PUT
 * returned `200` with the full body, but `GetFinanceTechnologyCosts`'s LEFT
 * JOIN is driven by the catalog, never by this table, so the row NEVER
 * surfaced on any GET. The operator believed the cost was configured while
 * every downstream CAC in Fase 3 kept reading `costoVentaArs: 0` — a zero
 * that reads as "all sales are profitable", not as "not configured".
 */
export class FinanceTechnologyNotFoundError extends DomainError {
  constructor(public readonly technologyName: string) {
    super(`No existe una tecnología "${technologyName}" en el catálogo de ContractTechnology`, 'FINANCE_TECHNOLOGY_NOT_FOUND');
    this.name = 'FinanceTechnologyNotFoundError';
  }
}

/**
 * finance-growth Fase 2 fix-wave-1 (finding D) — same rationale as
 * `FinanceTechnologyNotFoundError`, thrown by `UpdateFinancePlanPrice` when
 * `planCode` doesn't match any row in the `Plan` catalog
 * (`PlanRepository.findByCode`).
 */
export class FinancePlanNotFoundError extends DomainError {
  constructor(public readonly planCode: string) {
    super(`No existe un plan con código "${planCode}" en el catálogo de Plan`, 'FINANCE_PLAN_NOT_FOUND');
    this.name = 'FinancePlanNotFoundError';
  }
}
