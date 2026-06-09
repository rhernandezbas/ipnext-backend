# Design: Inventory Material Deduction (EPIC #38 W6)

## Technical Approach

Mirror the proven W4 returns architecture (stage → operator-confirm → atomic sourceRef-guarded movement), swapping RETURN→CONSUME, asset→material, depot-target→technician-source. STAGE is read-only and flag-gated; CONFIRM (`ConfirmMaterialDeduction`) is the ONLY mutation, atomic via `UnitOfWork`, with the W4 hardening verbatim: pre-write `findBySourceRef`, a TOCTOU re-check inside the tx, and P2002→409 (NOT poisoned-tx recovery). Flag `inventory-material-auto-deduct` default OFF = semi-auto.

## Architecture Decisions

| Decision | Choice | Rejected | Rationale |
|---|---|---|---|
| Staging model | Dedicated `MaterialDeductionSuggestion` (mirror `ReturnSuggestion`) | status-fields-on-`TaskMaterialConsumption` | A consumption is an immutable record; deduction is a separate workflow with status/resolution/sourceRef/review. Bolting 6 nullable workflow columns onto a hot table couples two lifecycles and blocks the W4-identical confirm/FE reuse. |
| Channel asymmetry | ONE `StageMaterialDeduction` use case; BOTH creators call it | inline-stage in each channel | Two creators (`RecordMaterialConsumption`, `ConfirmInventorySuggestion.handleMaterial`); one shared hook = no consumption escapes deduction. The DEVICE dual-write already proves the pattern; this is its MATERIAL twin. |
| Source location | task `ScheduledTask.assigneeId` → `ResolveTechnicianLocation('TECNICO')` | `recordedByUserId` | The assignee did the job; the recorder may be an office operator (explore Q2). |
| Insufficient/zero/null-assignee | never mutate → `needs_review`; operator resolves | go-negative / silent depot | Foundation guards negative stock; B4 rejected by design. |
| Idempotency | L1 per-consumption unique on suggestion + L2 `sourceRef` partial-unique on movement | Prisma `@@unique` | `@@unique` indexes legacy NULLs and collides; reuse the W4 hand-written partial unique (`WHERE sourceRef IS NOT NULL`). |

## Data Flow (ASCII)

```
RecordMaterialConsumption ─┐
                           ├─► consumptions.create() ─► StageMaterialDeduction (flag-gated, READ-ONLY)
ConfirmInv…handleMaterial ─┘                                │  resolve assignee TECNICO loc
                                                            │  check MaterialStock(tecnico, mat).qty
                                                            ▼
                          enough → status=pending  | short/none/null-assignee → needs_review
                                                            │
                          GET /deductions/pending  ◄────────┘
                                                            │ operator
                          POST /deductions/:id/confirm ─► ConfirmMaterialDeduction (UnitOfWork, ONLY mutation)
                            1. L1 terminal-status guard (409)
                            2. pre-write movements.findBySourceRef(consume:task-material:{cId}) → 409
                            3. TOCTOU re-check MaterialStock.qty INSIDE tx → short → needs_review/409
                            4. RecordInventoryMovement(CONSUME, fromLocationId=tecnico, mat, qty)
                            5. stamp consumption.deductedAt/deductedMovementId + suggestion=confirmed
                            (P2002 race loser → 409 at route, never poisoned-tx recovery)
```

needs_review resolutions (all atomic in the tx): `issue-first` = TRANSFER depot→tecnico then CONSUME from tecnico; `depot` = CONSUME from depot; `discard` = no movement.

## File Changes

| File | Action | Description |
|---|---|---|
| `domain/entities/material-deduction-suggestion.ts` | Create | entity + factory (mirror `return-suggestion.ts`) |
| `domain/ports/MaterialDeductionSuggestionRepository.ts` | Create | `create/get/setStatus/findPending` |
| `application/use-cases/StageMaterialDeduction.ts` | Create | read-only stager, flag-gated, L1-dedup |
| `application/use-cases/ConfirmMaterialDeduction.ts` | Create | the ONLY mutation; UoW + TOCTOU + sourceRef |
| `application/use-cases/RecordMaterialConsumption.ts` | Modify | call stage-hook after create |
| `application/use-cases/ConfirmInventorySuggestion.ts` (`handleMaterial`) | Modify | call the SAME stage-hook after `consumptions.create` |
| `domain/entities/task-material-consumption.ts` | Modify | `deductedAt`/`deductedMovementId` link fields |
| `domain/ports/UnitOfWork.ts` | Modify | add optional `deductions` + `consumptions` tx repos |
| `infrastructure/adapters/{prisma,in-memory}/` | Create/Modify | `*MaterialDeductionSuggestionRepository`, stock-qty read on stock repo |
| `infrastructure/http/routes/inventory.routes.ts` | Modify | `GET /deductions/pending`, `POST /deductions/:id/{confirm,discard}` + 409 map + DI |
| `prisma/migrations/2026..._inventory_material_deduction/` | Create | table + link columns + flag seed |
| `ipnext-frontend` "Descuentos pendientes" | Create | mirror W4 "Devoluciones pendientes" |

## Interfaces

```ts
interface MaterialDeductionSuggestion {
  id: string; taskMaterialConsumptionId: string; // UNIQUE — L1
  taskId: string; technicianId: string | null; materialCatalogId: string; qty: number;
  technicianLocationId: string | null;
  status: 'pending'|'needs_review'|'confirmed'|'discarded';
  resolution: 'deduct'|'issue-first'|'depot'|'discard' | null;
  sourceRef: string | null;            // consume:task-material:{consumptionId}
  deductedMovementId: string | null; createdAt: string; updatedAt: string;
}
```

## Idempotency (2-layer)

- **L1** — `taskMaterialConsumptionId UNIQUE` on the suggestion: a re-stage (partial-crash, double-record) silently dedups; one consumption = at most one suggestion.
- **L2** — `sourceRef = consume:task-material:{consumptionId}` on the CONSUME + the reused partial unique. Confirm does pre-write `findBySourceRef`→409; a true race loser hits P2002→409 at the route. Stock decremented exactly once. Link columns (`deductedAt`/`deductedMovementId`) are the FE "deducted ✓" guard.

Failure modes: double-record→L1 dedup; double-confirm→L1 terminal-status guard then findBySourceRef→409; concurrent confirm→P2002→409; stock drift after stage→TOCTOU re-check→needs_review.

## Migration / Rollout

Additive, NO backfill (existing consumptions stay `deductedAt=NULL` = never deducted): (1) `MaterialDeductionSuggestion` table + indexes + `taskMaterialConsumptionId` UNIQUE + FKs (taskId CASCADE, consumption CASCADE, material RESTRICT, deductedMovementId SET NULL); (2) `TaskMaterialConsumption.deductedAt/deductedMovementId` nullable; (3) **reuse** `InventoryMovement.sourceRef` + its partial unique from W4 (no new index needed — confirm it exists); (4) seed `inventory-material-auto-deduct=false`. Hand-write any new partial unique; never `@@unique`.

## Testing Strategy

| Layer | What | How |
|---|---|---|
| Unit | stage dedup (L1), needs_review on short/null-assignee, flag OFF = no auto-deduct | in-memory repos |
| Unit | confirm: deduct/issue-first/depot/discard, TOCTOU re-check, double-confirm→409 | in-memory UoW rollback |
| Integration | BOTH channels stage exactly one suggestion (kills asymmetry) | supertest |
| Integration | confirm decrements once; P2002 race→409 | supertest |

## Open Questions

- [ ] `issue-first` source depot: reuse `ResolveDepotLocation('DEPOSITO')` — confirm single depot assumption.
