# Inventory Material Deduction Specification

## Purpose

When a task records material consumption, the technician's TECNICO stock MUST eventually be decremented to match physical reality. This spec covers the semi-automatic stage→confirm pipeline that closes that gap, gated behind a feature flag so operators retain control of each deduction.

## Requirements

### Requirement: Stage Deduction Suggestion (flag-gated, read-only)

When a `TaskMaterialConsumption` is created via EITHER `RecordMaterialConsumption` OR `ConfirmInventorySuggestion.handleMaterial` AND the flag `inventory-material-auto-deduct` is ON, the system MUST stage exactly one `MaterialDeductionSuggestion` per consumption (L1 idempotency). Staging MUST NOT mutate any stock.

The system MUST resolve `ScheduledTask.assigneeId` → TECNICO location. If the tech's `MaterialStock` for that material meets or exceeds `qty` → status `pending`. If stock is insufficient, zero, or the task has no assignee → status `needs_review`. The system MUST NOT re-stage a consumption that already has a suggestion (per-consumption flag).

When the flag is OFF, consumption MUST still be recorded; NO suggestion is staged.

#### Scenario: SCEN-SD-1 — stage via RecordMaterialConsumption (sufficient stock)

- GIVEN flag is ON, task has assignee with TECNICO stock qty >= consumption qty
- WHEN `RecordMaterialConsumption` creates a `TaskMaterialConsumption`
- THEN one `MaterialDeductionSuggestion` with status `pending` is created
- AND no stock is mutated

#### Scenario: SCEN-SD-2 — stage via ConfirmInventorySuggestion.handleMaterial

- GIVEN flag is ON, task has assignee with sufficient TECNICO stock
- WHEN `ConfirmInventorySuggestion` confirms a MATERIAL suggestion
- THEN one `MaterialDeductionSuggestion` with status `pending` is created
- AND no stock is mutated

#### Scenario: SCEN-SD-3 — insufficient stock → needs_review

- GIVEN flag is ON, task has assignee but TECNICO MaterialStock qty < consumption qty
- WHEN either consumption channel fires
- THEN `MaterialDeductionSuggestion` is created with status `needs_review`
- AND no stock is mutated

#### Scenario: SCEN-SD-4 — no assignee → needs_review

- GIVEN flag is ON, task has no `assigneeId`
- WHEN either consumption channel fires
- THEN `MaterialDeductionSuggestion` is created with status `needs_review`

#### Scenario: SCEN-SD-5 — flag OFF → no suggestion staged

- GIVEN flag `inventory-material-auto-deduct` is OFF
- WHEN `RecordMaterialConsumption` creates a consumption
- THEN consumption is persisted AND no `MaterialDeductionSuggestion` is created

#### Scenario: SCEN-SD-6 — L1 idempotency: re-stage skipped

- GIVEN a `MaterialDeductionSuggestion` already exists for consumptionId C1
- WHEN the stage-hook is called again for C1 (e.g. retry)
- THEN no new suggestion is created; the existing suggestion is unchanged

---

### Requirement: Confirm Deduction (operator mutation, atomic)

The system MUST confirm a `pending` `MaterialDeductionSuggestion` inside a `UnitOfWork`: re-check the tech's TECNICO stock at confirm time (TOCTOU guard); call `RecordInventoryMovement(CONSUME, fromLocationId=tecnico, materialCatalogId, qty)`; stamp `deductedAt`/`movementId` on the consumption; set suggestion status `confirmed`. A CONSUME that would result in qty < 0 MUST be rejected. Pre-write `findBySourceRef('consume:task-material:{consumptionId}')` MUST be called inside the UoW BEFORE writing; if found → return 409 (never rely on post-abort P2002 recovery). The PARTIAL UNIQUE on `sourceRef WHERE sourceRef IS NOT NULL` provides the L2 concurrency backstop.

#### Scenario: SCEN-CF-1 — confirm pending → stock decremented atomically

- GIVEN a suggestion with status `pending` and sufficient TECNICO stock
- WHEN operator confirms (resolution=deduct)
- THEN tech's MaterialStock qty decremented by consumption qty
- AND consumption row has `deductedAt` and `movementId` set
- AND suggestion status is `confirmed`

#### Scenario: SCEN-CF-2 — TOCTOU: stock dropped between stage and confirm

- GIVEN a suggestion staged as `pending` but tech's stock was subsequently reduced below required qty
- WHEN operator confirms
- THEN confirm is rejected; suggestion becomes `needs_review`; stock is NOT mutated

#### Scenario: SCEN-CF-3 — double-confirm / concurrent confirm → 409

- GIVEN suggestion C1 was already confirmed (sourceRef exists in InventoryMovement)
- WHEN confirm is called again for C1
- THEN response is 409 `DEDUCTION_ALREADY_CONFIRMED`; stock is NOT decremented a second time

#### Scenario: SCEN-CF-4 — never-negative guard

- GIVEN tech's MaterialStock qty = 3 and consumption qty = 5
- WHEN confirm is attempted
- THEN confirm is rejected; no movement created; stock remains 3

---

### Requirement: needs_review Resolutions

An operator MAY resolve a `needs_review` suggestion via one of four strategies: `issue-first` (TRANSFER depot→tecnico THEN CONSUME, both in one UoW), `depot` (CONSUME from depot location directly), `deduct` (re-attempt from tecnico after manual stock adjustment), or `discard` (no movement, mark suggestion discarded).

#### Scenario: SCEN-NR-1 — issue-first resolves via TRANSFER + CONSUME

- GIVEN a suggestion in `needs_review`
- WHEN operator resolves with `issue-first`
- THEN one TRANSFER (depot→tecnico) and one CONSUME (tecnico) are recorded atomically
- AND tech's net stock is unchanged; depot stock decremented

#### Scenario: SCEN-NR-2 — depot resolves via direct CONSUME

- GIVEN a suggestion in `needs_review`
- WHEN operator resolves with `depot`
- THEN one CONSUME from the depot location is recorded
- AND suggestion is confirmed; depot stock decremented

#### Scenario: SCEN-NR-3 — discard closes suggestion with no movement

- GIVEN a suggestion in `needs_review`
- WHEN operator discards
- THEN suggestion status is `discarded`; no InventoryMovement is created; no stock changes

---

### Requirement: Permission Gating

`GET /api/inventory/deductions/pending` REQUIRES permission `inventory.read`. `POST /api/inventory/deductions/:id/confirm` and `POST /api/inventory/deductions/:id/discard` REQUIRE permission `inventory.write`. Requests without the required permission MUST return 403.

#### Scenario: SCEN-PG-1 — read requires inventory.read

- GIVEN user lacks `inventory.read`
- WHEN `GET /api/inventory/deductions/pending` is called
- THEN 403 is returned

#### Scenario: SCEN-PG-2 — confirm requires inventory.write

- GIVEN user has `inventory.read` but lacks `inventory.write`
- WHEN `POST /api/inventory/deductions/:id/confirm` is called
- THEN 403 is returned

---

## Domain Model

| Entity | Key Fields |
|--------|-----------|
| `MaterialDeductionSuggestion` | `id`, `consumptionId` (unique), `taskId`, `materialCatalogId`, `qty`, `status: pending\|needs_review\|confirmed\|discarded`, `tecnicoLocationId`, `sourceRef: consume:task-material:{consumptionId}` |
| `TaskMaterialConsumption` (extended) | + `deductedAt: DateTime?`, `movementId: String?` (link to InventoryMovement) |

## Ports

| Port | Methods |
|------|---------|
| `MaterialDeductionSuggestionRepository` | `findByConsumptionId`, `create`, `updateStatus`, `listPending`, `findBySourceRef` |
