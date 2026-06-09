# Proposal: Inventory Material Deduction (EPIC #38, Wave 6)

## Intent

Today a `TaskMaterialConsumption` records what a task consumed but **decrements no stock** — the technician's physical count never moves. W6 closes that gap: when a task consumes a material, **deduct it from the task assignee's TECNICO stock**, semi-automatically (operator confirms each deduction), behind a default-OFF flag. HIGH-RISK: a wrong decrement is a wrong physical count, so idempotency, a re-check at confirm, and an operator escape hatch are non-negotiable. This re-applies the proven W4 `iclass-inventory-returns` architecture (stage → operator-confirm → atomic sourceRef-guarded movement) swapping RETURN→CONSUME, asset→material, depot-target→technician-source.

## Scope

### In Scope
- A `MaterialDeductionSuggestion` staging model (mirrors `ReturnSuggestion`) + migration: per-consumption L1 flag, consumption↔movement link (`deductedAt`/`movementId`).
- **STAGE** (read-only, gated by flag, never mutates): both consumption channels (`RecordMaterialConsumption` + `ConfirmInventorySuggestion.handleMaterial`) route through one stager → resolve assignee TECNICO location, check MaterialStock → `pending` or `needs_review`.
- **CONFIRM** (operator, the only mutation): `RecordInventoryMovement(CONSUME)` via `UnitOfWork`, atomic, sourceRef-guarded, re-checks stock inside the tx (TOCTOU).
- needs_review resolutions: `deduct` | `issue-first` (TRANSFER depot→tecnico then CONSUME) | `depot` (CONSUME from depot) | `discard`.
- Routes: `GET /api/inventory/deductions/pending`, `POST /api/inventory/deductions/:id/confirm`, `POST /api/inventory/deductions/:id/discard`.
- FeatureFlag `inventory-material-auto-deduct` (default OFF = semi-auto staging).
- FE "Descuentos pendientes" page mirroring W4 "Devoluciones pendientes".

### Out of Scope
- AUTO mode (flag ON = inline deduct at record-time) — model the flag now, wire later.
- Backfill of historical consumptions (NULL `deductedAt` = never deducted, by design).
- Reversal/edit of an already-confirmed deduction (corrections = a new compensating movement, future).

## Capabilities

### New Capabilities
- `inventory-material-deduction`: stage a pending `MaterialDeductionSuggestion` per consumption (read-only, flag-gated); operator confirms → atomic CONSUME from the task assignee's TECNICO stock; needs_review when stock insufficient; sourceRef + per-consumption idempotency.

### Modified Capabilities
- None. (Both consumption creators gain a stage-hook call, but no spec-level requirement of `service-inventory` changes; the deduction is a new capability layered on top.)

## Approach

STAGE-then-CONFIRM, two use cases over the existing `RecordInventoryMovement` primitive and `UnitOfWork`:

1. **Stage** — at consumption-record time, BOTH channels call one stager (kills channel asymmetry). Resolve `ScheduledTask.assigneeId` → `findByTypeAndTechnician('TECNICO', id)`. Check the tech's MaterialStock: enough → `pending`; short/none/null-assignee → `needs_review`. L1 idempotency: per-consumption flag — never re-stage. Never mutates stock.
2. **Confirm** (operator, only mutation) — inside `UoW`: PRE-WRITE `findBySourceRef('consume:task-material:{consumptionId}')`; **re-check stock inside the tx** (TOCTOU guard, W4 lesson); `RecordInventoryMovement(CONSUME, fromLocationId=tecnico, materialCatalogId, qty)`; stamp `deductedAt`/`movementId` on the consumption; set suggestion `confirmed`. P2002 → 409 (pre-write check, NOT post-abort recovery on a poisoned tx — the W4 bug).
3. **Idempotency** — L2 `sourceRef` on the CONSUME + the hand-written PARTIAL UNIQUE (`WHERE sourceRef IS NOT NULL`, reused from W4), NOT a Prisma `@@unique`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `application/use-cases/RecordMaterialConsumption.ts` | Modified | call the stage-hook after create |
| `application/use-cases/ConfirmInventorySuggestion.ts` (`handleMaterial`) | Modified | call the same stage-hook (the missing twin of the DEVICE dual-write) |
| `application/use-cases/StageMaterialDeduction.ts` | New | read-only stager (flag-gated) |
| `application/use-cases/ConfirmMaterialDeduction.ts` | New | the only mutation; atomic UoW; sourceRef + TOCTOU re-check |
| `domain/entities/material-deduction-suggestion.ts` + `.../ports` | New | staging entity + repository port |
| `domain/entities/task-material-consumption.ts` | Modified | `deductedAt`/`movementId` link |
| `infrastructure/adapters/prisma/` + `in-memory/` | New/Modified | repo adapters for the staging model |
| `infrastructure/http/routes/inventory*.routes.ts` | Modified | pending/confirm/discard endpoints + DI wiring |
| `prisma/migrations/2026..._inventory_material_deduction/` | New | staging table + link columns + seed flag (reuse W4 sourceRef + partial unique) |
| `ipnext-frontend` "Descuentos pendientes" | New | confirm/review page mirroring W4 returns |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Wrong decrement = wrong physical count | High | default-OFF flag, operator confirm, sourceRef idempotency, negative-stock guard |
| Channel asymmetry (one creator skips staging) | High | both creators call the SAME stage-hook; covered by tests on both paths |
| TOCTOU: stock drifts between stage and confirm | Med | re-check stock INSIDE the confirm UoW; reject/needs_review if no longer sufficient |
| Double-confirm corrupts stock | Med | pre-write `findBySourceRef` + PARTIAL UNIQUE → 409, never a poisoned-tx recovery |
| Insufficient/zero/null-assignee stock goes negative | Med | never mutate on shortfall → `needs_review`; operator picks issue-first/depot/discard |
| Migration on hot `TaskMaterialConsumption` | Low | additive nullable columns, no backfill (NULL = never deducted) |

## Rollback Plan

Flip `inventory-material-auto-deduct` OFF (it already is) and stop staging via a kill check, or revert the stage-hook calls — no stock was ever mutated by staging. Confirmed deductions are real movements: reverse with compensating CONSUME-reversal movements (do NOT delete ledger rows). Migration columns are nullable/additive → safe to leave in place on rollback.

## Dependencies

- W4 `iclass-inventory-returns`: `sourceRef`, `findBySourceRef`, the PARTIAL UNIQUE index, the stage→confirm blueprint.
- W5a: `ResolveTechnicianLocation` (`findByTypeAndTechnician('TECNICO', id)`), `ResolveDepotLocation`.
- `RecordInventoryMovement` (CONSUME verb), `UnitOfWork`, `FeatureFlagRepository`.

## Success Criteria

- [ ] Recording a consumption (either channel) stages exactly one suggestion; never re-stages (L1).
- [ ] Staging never mutates stock; the flag defaults OFF.
- [ ] Confirm decrements the assignee's TECNICO MaterialStock atomically and stamps `deductedAt`/`movementId`.
- [ ] Double-confirm → 409, stock decremented exactly once (sourceRef + partial unique).
- [ ] Stock drift between stage and confirm → confirm rejects/needs_review (TOCTOU re-check).
- [ ] Insufficient/zero/null-assignee stock → `needs_review`, never negative; operator resolves via deduct/issue-first/depot/discard.
- [ ] No historical consumption is backfilled (all pre-existing rows stay `deductedAt = NULL`).
