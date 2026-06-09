# Tasks: Inventory Material Deduction (EPIC #38, Wave 6)

## Phase 1 — Schema + Migration

- [x] 1.1 Hand-author `prisma/migrations/20260613000000_inventory_material_deduction/migration.sql`: idempotent; create `MaterialDeductionSuggestion` table with `taskMaterialConsumptionId UNIQUE`, status/resolution/sourceRef columns, FKs (task CASCADE, consumption CASCADE, material RESTRICT, deductedMovementId SET NULL). Verify `InventoryMovement.sourceRef` partial unique from W4 already exists — do NOT recreate.
- [x] 1.2 Add nullable `deductedAt TIMESTAMP` + `deductedMovementId TEXT` columns to `TaskMaterialConsumption` in the same migration.sql. Confirm columns are nullable/additive (no backfill).
- [x] 1.3 Seed `inventory-material-auto-deduct` flag (value `false`) in the migration; reuse `FeatureFlag` INSERT pattern from W4 seeds.
- [x] 1.4 Run `npx prisma generate` to update the Prisma client (no `prisma migrate`).

## Phase 2 — Domain + Ports

- [x] 2.1 Create `src/domain/entities/material-deduction-suggestion.ts`: `MaterialDeductionSuggestion` interface + factory function, mirroring `return-suggestion.ts`; fields per design interface (id, consumptionId, status, resolution, sourceRef, deductedMovementId, tecnicoLocationId, etc.).
- [x] 2.2 Extend `src/domain/entities/task-material-consumption.ts` with optional `deductedAt: Date | null` and `deductedMovementId: string | null` fields.
- [x] 2.3 Create `src/domain/ports/MaterialDeductionSuggestionRepository.ts`: methods `create`, `findByConsumptionId`, `updateStatus`, `listPending`, `findBySourceRef`.
- [x] 2.4 Add optional `deductions` and `consumptions` tx-repo slots to `src/domain/ports/UnitOfWork.ts` (matches design: ConfirmMaterialDeduction needs both in the tx).

## Phase 3 — STAGE (TDD, no mutation) — SCEN-SD-1..6

- [x] 3.1 [RED] Write `src/__tests__/application/StageMaterialDeduction.test.ts`: tests for SCEN-SD-1 (pending via RecordMaterialConsumption), SCEN-SD-3 (insufficient stock → needs_review), SCEN-SD-4 (no assignee → needs_review), SCEN-SD-5 (flag OFF → no suggestion), SCEN-SD-6 (L1 dedup). All with in-memory repos.
- [x] 3.2 Create `src/infrastructure/adapters/in-memory/InMemoryMaterialDeductionSuggestionRepository.ts` implementing the port.
- [x] 3.3 [GREEN] Create `src/application/use-cases/StageMaterialDeduction.ts`: flag-gated; resolve assignee TECNICO via `ResolveTechnicianLocation`; check `MaterialStock.qty`; `findByConsumptionId` L1 guard (return early if exists); `create` suggestion with `pending` or `needs_review`. NEVER mutates stock.
- [x] 3.4 [RED] Write integration test in `src/__tests__/infrastructure/` for SCEN-SD-2: `ConfirmInventorySuggestion.handleMaterial` channel stages exactly one suggestion (supertest, in-memory repos, flag ON).
- [x] 3.5 [GREEN] Modify `src/application/use-cases/RecordMaterialConsumption.ts`: call `StageMaterialDeduction` after `consumptions.create` (covers SCEN-SD-1).
- [x] 3.6 [GREEN] Modify `src/application/use-cases/ConfirmInventorySuggestion.ts` (`handleMaterial`): call the SAME `StageMaterialDeduction` after `consumptions.create` (covers SCEN-SD-2; kills channel asymmetry).

## Phase 4 — CONFIRM (TDD, the mutation) — SCEN-CF-1..4, SCEN-NR-1..3

- [x] 4.1 Create `src/infrastructure/adapters/prisma/PrismaMaterialDeductionSuggestionRepository.ts` (all 5 port methods, using generated Prisma client).
- [x] 4.2 [RED] Write `src/__tests__/application/ConfirmMaterialDeduction.test.ts`: SCEN-CF-1 (pending → confirmed + stock decremented), SCEN-CF-2 (TOCTOU → needs_review), SCEN-CF-3 (double-confirm → 409), SCEN-CF-4 (never-negative), SCEN-NR-1 (issue-first), SCEN-NR-2 (depot), SCEN-NR-3 (discard). In-memory UoW.
- [x] 4.3 [GREEN] Create `src/application/use-cases/ConfirmMaterialDeduction.ts`: (1) terminal-status guard → 409; (2) pre-write `findBySourceRef('consume:task-material:{consumptionId}')` → 409; (3) TOCTOU re-check `MaterialStock.qty` INSIDE UoW tx → short → flip `needs_review`; (4) `RecordInventoryMovement(CONSUME, fromLocationId=tecnico, mat, qty)`; (5) stamp `deductedAt`/`deductedMovementId` on consumption; (6) set suggestion `confirmed`. `needs_review` resolutions: `issue-first` = TRANSFER+CONSUME in one tx; `depot` = CONSUME from depot; `discard` = no movement.
- [x] 4.4 [RED] Write route integration tests in `src/__tests__/infrastructure/inventory-deductions.routes.test.ts`: SCEN-PG-1 (GET 403), SCEN-PG-2 (POST confirm 403), concurrent double-confirm (W4 regression guard), discard 200.
- [x] 4.5 [GREEN] Modify `src/infrastructure/http/routes/inventory.routes.ts`: add `GET /deductions/pending`, `POST /deductions/:id/confirm`, `POST /deductions/:id/discard`; map P2002 + explicit 409 (`DEDUCTION_ALREADY_CONFIRMED`); wire DI (inject `PrismaMaterialDeductionSuggestionRepository`, `ConfirmMaterialDeduction`).
- [x] 4.6 Register the new routes in `src/infrastructure/http/app.ts`.

## Phase 5 — Frontend

- [x] 5.1 Create `src/pages/inventory/DeductionsPendingPage.tsx` mirroring W4 `ReturnsPendingPage`: fetch `GET /api/inventory/deductions/pending`; table of pending/needs_review suggestions with material name, qty, task, technician, status badge.
- [x] 5.2 Create `src/hooks/useDeductionsPending.ts` (mocked in tests): wraps GET pending + POST confirm/discard mutations.
- [x] 5.3 Add resolution modal (mirroring W4 review modal): `deduct` / `issue-first` / `depot` / `discard` options; show only applicable options per suggestion status.
- [x] 5.4 Wire page into the router + sidebar nav under Inventario ("Descuentos pendientes").
- [x] 5.5 Write unit tests with mocked hook for all resolution paths and empty-state rendering.

## Phase 6 — Verify

- [x] 6.1 Run `npx jest --runInBand` (BE); confirm all 15 spec scenarios green (SCEN-SD-1..6, SCEN-CF-1..4, SCEN-NR-1..3, SCEN-PG-1..2). Result: 2838 pass / 86 skip / 0 fail (baseline was 2814 — +24 new tests).
- [x] 6.2 Run `npx tsc --noEmit` on BE; zero type errors.
- [ ] 6.3 Run `npx vitest run` + `npx tsc --noEmit` on FE; all tests green.
- [x] 6.4 Confirm `InventoryMovement.sourceRef` partial unique is NOT duplicated in the new migration (verified: W4 migration `20260612000000_iclass_returns/migration.sql` already defines it; W6 migration does not recreate it).
- [x] 6.5 Confirm no `prisma migrate` was run; only `npx prisma generate` + hand-authored `prisma/migrations/20260613000000_inventory_material_deduction/migration.sql`.

## Fix wave (post-review)

Adversarial 4-reviewer review applied. All 7 FIX-FIRST findings resolved. Final gate: 2851 pass / 86 skip / 0 fail; `tsc --noEmit` clean.

- [x] FIX-1: `migration.sql` — removed `DEFAULT CURRENT_TIMESTAMP` from `updatedAt` (Prisma owns that column; DB default causes double-update drift). File: `prisma/migrations/20260613000000_inventory_material_deduction/migration.sql:39`.
- [x] FIX-2: W1 single-rounding rule — all qty goes through `roundQty()` (Number(n.toFixed(4))) for Decimal(12,4) parity. Applied in entity factory, StageMaterialDeduction comparison, and PrismaMaterialDeductionSuggestionRepository.create(). Files: `src/domain/entities/material-deduction-suggestion.ts`, `src/application/use-cases/StageMaterialDeduction.ts`, `src/infrastructure/adapters/prisma/PrismaMaterialDeductionSuggestionRepository.ts`.
- [x] FIX-3: UnitOfWork exposes `stock?: MaterialStockRepository` in TransactionalRepos; PrismaUoW wires `PrismaMaterialStockRepository(tx)`; InMemoryUoW passes `this.materialStock`; ConfirmMaterialDeduction uses `repos.stock ?? this.stock` in the tx bag. Files: `src/domain/ports/UnitOfWork.ts`, `src/infrastructure/adapters/prisma/PrismaUnitOfWork.ts`, `src/infrastructure/adapters/in-memory/InMemoryUnitOfWork.ts`, `src/application/use-cases/ConfirmMaterialDeduction.ts`. Route: `InsufficientStockError` → 409 INSUFFICIENT_STOCK.
- [x] FIX-4: `updateStatus()` uses Prisma `updateMany` with `status: { in: ['pending','needs_review'] }` guard; returns null on 0 rows; InMemoryMaterialDeductionSuggestionRepository terminal-guard mirrors this. All `return updated!` calls in ConfirmMaterialDeduction replaced with explicit null-check throws. Files: `src/infrastructure/adapters/prisma/PrismaMaterialDeductionSuggestionRepository.ts`, `src/infrastructure/adapters/in-memory/InMemoryMaterialDeductionSuggestionRepository.ts`, `src/application/use-cases/ConfirmMaterialDeduction.ts`.
- [x] FIX-5: `DeductionHasNoTechnicianError` (code `DEDUCTION_NO_TECHNICIAN`) added to domain errors; `handleIssueFirst` throws it when `technicianLocationId` is null (removed unsafe `?? depot.id` fallback); route maps to 409. Files: `src/domain/errors/inventory.ts`, `src/application/use-cases/ConfirmMaterialDeduction.ts`, `src/infrastructure/http/routes/inventory.routes.ts`.
- [x] FIX-6: FE contract alignment — `MaterialDeductionSuggestionDto` rewritten with `consumptionId`, `materialId`, `materialName`, `materialUnit`, `technicianName`, `taskSeq`, `taskTitle`; `ListPendingDeductions` refactored with batch lookups (no N+1); `app.ts` wires enrichment repos. Files: `src/application/dto/MaterialDeductionSuggestionDto.ts`, `src/application/use-cases/ListPendingDeductions.ts`, `src/infrastructure/http/app.ts`.
- [x] FIX-7a: SCEN-SD-1 seam test — RecordMaterialConsumption with staging wired → suggestion staged. File: `src/__tests__/application/StageMaterialDeduction.test.ts`.
- [x] FIX-7b: SCEN-SD-2 seam test — ConfirmInventorySuggestion with 12th arg staging → exactly one suggestion staged. File: `src/__tests__/application/StageMaterialDeduction.test.ts`.
- [x] FIX-7c: Composition-root static analysis tests — verify app.ts passes `stageMaterialDeduction` into ConfirmInventorySuggestion (12th arg) and RecordMaterialConsumption (stage object), and `ListPendingDeductions`/`ConfirmMaterialDeduction` into createInventoryRouter. File: `src/__tests__/infrastructure/inventory-composition-root.test.ts`.
- [x] FIX-7d: Terminal-guard serial double-confirm test — first confirm succeeds, second hits L1 (confirmed status) → `DeductionAlreadyConfirmedError`; exactly one CONSUME movement; stock decremented only once. File: `src/__tests__/application/ConfirmMaterialDeduction.test.ts`.
- [x] FIX-7e: SCEN-NR-1 net-unchanged assertion — after issue-first, technician stock is net 0 (TRANSFER +qty, CONSUME −qty). File: `src/__tests__/application/ConfirmMaterialDeduction.test.ts`.
