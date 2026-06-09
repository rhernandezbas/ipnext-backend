# Exploration: inventory-material-deduction (EPIC #38, Wave 6)

> **HIGH-RISK.** This wave mutates real stock balances FROM tasks — the user's central
> requirement ("se descuente automático o semi automático de las tareas"). A wrong
> decrement is a wrong physical count. Idempotency and an operator-confirm escape hatch
> are non-negotiable.

## Goal (the user's words)

> "lleva control si gastan otros materiales, POEs, conectores, etc" + "el modelo es que
> se descuente automático o semi automático de las tareas y equipo técnicos" +
> "inventario x técnico para llevar control".

When a task consumes materials, **DEDUCT them from the TECHNICIAN's stock** (the
per-technician TECNICO `StockLocation` shipped in W5a), auto or semi-auto.

---

## Current State — how a consumption is recorded today, and the gap

A `TaskMaterialConsumption` row is created through **two channels**, and **NEITHER touches stock**:

1. **Manual / operator-direct** — `RecordMaterialConsumption`
   (`src/application/use-cases/RecordMaterialConsumption.ts`).
   Validates qty>0 + material exists, snapshots `materialName`, calls
   `consumptions.create(...)`. **No `MaterialStock`, no `RecordInventoryMovement`,
   no location.** Wired at `contractInventory.routes.ts:70` (`recordConsumption`).

2. **From a confirmed IClass/OCR material suggestion** —
   `ConfirmInventorySuggestion.handleMaterial`
   (`src/application/use-cases/ConfirmInventorySuggestion.ts:423-460`).
   The DEVICE branch of this same use case ALREADY dual-writes
   (`InventoryAsset` + `INSTALL` movement, atomic, lines 132-198). The **MATERIAL
   branch does NOT** — it resolves/creates the catalog material, calls
   `consumptions.create(...)`, sets the suggestion `confirmed`, and returns. No movement.

> **CONFIRMED (W1 explore was right):** material consumption **records the consumption
> but DECREMENTS NO STOCK.** That gap is exactly what W6 closes.

The `TaskMaterialConsumption` entity (`src/domain/entities/task-material-consumption.ts`)
and Prisma model (`schema.prisma:562-578`) have **no link to a movement** — no
`movementId`, no `deductedAt`, no `fromLocationId`. There is no idempotency anchor today.

### Where IClass materials come from (CONFIRMED — they are NOT empty)

The task brief flagged "CONFIRM IClassSoMaterial is empty / not a usable source." The code
says the opposite of the W4 assumption, and this is important:

- `IngestClosedServiceOrders.ts:234` calls `this.iclass.getServiceOrderMaterials(...)` and
  passes them to `BuildInventorySuggestions.execute({ materials: order.materials })`
  (line 303).
- `BuildInventorySuggestions.ts:30-33,57-75` stages each material with a
  `materialDescription` as a **`MATERIAL` suggestion** (`source: 'ICLASS_MATERIAL'`,
  `status: 'pending'`).
- An operator confirms it via `ConfirmInventorySuggestion.handleMaterial` → a
  `TaskMaterialConsumption`.

**So IClass materials ARE a live source feeding consumptions through the operator-confirm
channel.** Whether `IClassSoMaterial` is *populated in prod* is an env/data question, but
in code it is fully wired. Either way the design conclusion is the same: **W6 hangs off the
`TaskMaterialConsumption` creation point**, which both channels funnel through. W6 does NOT
need to read IClass directly. (Open question Q5 below verifies prod data volume.)

### Foundation W6 reuses (all shipped, all proven)

- **`RecordInventoryMovement` / `InventoryMovementRepository.record()`** — THE only stock
  mutation point. Atomic (ledger row + `MaterialStock.qty` materialized balance), TOCTOU-free
  negative-stock guard lives in the adapter. `CONSUME` is a material-only verb
  (`inventory-movement.ts:86`, factory forbids asset CONSUME) and requires `fromLocationId`
  (line 114). Decrements at `fromLocationId`. **Exactly the W6 primitive.**
- **`sourceRef` L2 idempotency** (W4) — `RecordMovementInput.sourceRef` +
  `findBySourceRef(sourceRef)` + a hand-written PARTIAL UNIQUE index
  (`WHERE sourceRef IS NOT NULL`, see `20260612000000_iclass_returns/migration.sql`).
  Re-insert → P2002 → resolve to existing. **The exact idempotency mechanism W6 needs**
  ("a consumption must deduct ONCE"): key it `consume:task-material:{consumptionId}`.
- **`ResolveTechnicianLocation`** (W5a, `ResolveTechnicianLocation.ts`) — find-or-create the
  TECNICO `StockLocation` for a technician id (`findByTypeAndTechnician('TECNICO', id)`).
- **`ResolveDepotLocation`** — the DEPOSITO location (for the fallback option).
- **`UnitOfWork.runInTransaction`** — atomic multi-repo writes (used by `ConfirmAssetReturn`,
  `IssueStockToTechnician`, `ConfirmInventorySuggestion`).
- **The technician** = `ScheduledTask.assigneeId` → `RbacUser`. The consumption itself has
  `recordedByUserId` (who keyed it) — that is NOT necessarily the assignee. W6 must read the
  **task's `assigneeId`** for the source location, not `recordedByUserId` (see Q2).
- **`FeatureFlagRepository`** (`src/domain/ports/FeatureFlagRepository.ts`) — key-based runtime
  toggles (`get`/`setEnabled`). Already gates `iclass-inventory-returns` (default OFF) and
  `iclass-audit`. **This is the auto/semi-auto switch mechanism** — no redeploy, UI-toggleable.
- **The W4 returns pair as the architectural blueprint**: `StageReturnSuggestions`
  (read-only staging) + `ConfirmAssetReturn` (the ONLY mutation, atomic, sourceRef-guarded,
  re-checks precondition inside the UoW, clean 409 on double-confirm). **W6 semi-auto = the
  same shape for a CONSUME.**

---

## Affected Areas

- `src/application/use-cases/RecordMaterialConsumption.ts` — channel 1; the natural deduction hook.
- `src/application/use-cases/ConfirmInventorySuggestion.ts:423-460` — channel 2 (`handleMaterial`); the gap twin of the DEVICE dual-write already above it.
- `src/domain/entities/task-material-consumption.ts` + `prisma/schema.prisma:562-578` — needs the consumption↔movement link (`movementId` / `deductedAt`). **Migration.**
- `src/application/use-cases/RecordInventoryMovement.ts` + `InventoryMovementRepository` — reused as-is for the CONSUME.
- `src/application/use-cases/ResolveTechnicianLocation.ts` / `ResolveDepotLocation.ts` — source-location resolution.
- `src/infrastructure/http/routes/contractInventory.routes.ts` — DI wiring of the new deps; possibly a `confirm-deduction` endpoint (semi-auto).
- `prisma/migrations/2026..._inventory_material_deduction/` — new migration (link column + optional `MaterialDeductionSuggestion` table + seed the feature flag).
- A new staging entity/table IF semi-auto-as-pending-suggestion is chosen (mirror `ReturnSuggestion`).
- FE (`ipnext-frontend`) — a focused confirm/review surface for semi-auto + a "deducted" indicator on the consumption list.

---

## Design Options (lay out — do NOT decide here)

### A) The TRIGGER — when does the CONSUME fire?

| Option | Description | Pros | Cons |
|---|---|---|---|
| **A1 on-record** | Deduct synchronously inside `RecordMaterialConsumption` / `handleMaterial`, in the same tx | Simplest; one consumption = one deduction; no extra table; consumption row is born already-deducted | Fires on EVERY consumption incl. mistakes; an over-keyed qty hits stock immediately; rollback = delete consumption + reverse movement |
| **A2 on-close** | Defer; deduct all of a task's consumptions when the task closes (`isClosed`) | Batches; matches "de las tareas"; one settle point | Consumptions edited/deleted before close never deducted (good) but a re-opened/re-closed task needs idempotency per consumption anyway; closure pipeline already crowded |
| **A3 review-confirm** | Stage a pending `MaterialDeductionSuggestion`; operator confirms in a screen → CONSUME (mirror W4 returns) | Safest; operator sees insufficient-stock BEFORE mutating; exact W4 pattern; auto vs semi-auto becomes "skip the review or not" | Most build (new table + use case + route + FE); a second confirm step |

The user said **"de las tareas"** → tie to the task. A1 and A3 both satisfy that; A1 is the
auto end, A3 is the semi-auto end. **A2 is the weakest** (closure pipeline coupling, and a
consumption can exist long before close). Recommend treating **A1 and A3 as the two ends of
ONE toggle** (see option C).

### B) The SOURCE LOCATION — decrement from where?

Resolve the **task's technician**: `ScheduledTask.assigneeId` → `ResolveTechnicianLocation` →
TECNICO `StockLocation`. Then the insufficient-stock question (technician never got it issued
in W5a, so TECNICO qty = 0):

| Option | Behavior on tech-has-0 | Pros | Cons |
|---|---|---|---|
| **B1 reject** | `record()` negative-stock guard throws → 409, no deduction | Honest; forces W5a issue discipline; zero silent corruption | A real consumption gets blocked because issue tracking lagged; operator friction |
| **B2 depot fallback** | If TECNICO has <qty, CONSUME from DEPOSITO instead | Pragmatic; mirrors real ISPs where the tech grabbed from the truck/depot directly | Hides the missing W5a issue; "from the technician's stock" becomes a lie; which gets ugly with partial qty |
| **B3 stage needs-review** | TECNICO short → don't mutate, mark the suggestion `needs_review` (A3 only) | No corruption + an operator signal; exact `ReturnSuggestion.needs_review` analog | Requires the A3 staging table; not available in pure-auto A1 |
| **B4 go negative** | Allow TECNICO to go below 0 | — | **REJECTED**: the foundation guards against it by design; never |

The assignee may be **null** (unassigned task) — a fourth edge: no technician → no TECNICO
location. Must reject or fall back to depot. Recommend: source = TECNICO of the task
assignee; **B1 (reject) for auto**, **B3 (needs-review) for semi-auto**, with **B2 (depot
fallback) as an explicit, separately-flagged operator choice** — never the silent default.

### C) AUTO vs SEMI-AUTO — the user wants both, configurable

Model as ONE `FeatureFlag` (e.g. `inventory-material-auto-deduct`, default **OFF** = safe),
exactly like `iclass-inventory-returns`:

- **AUTO (flag ON)** = trigger A1: the CONSUME fires in the same tx as the consumption record.
  On insufficient stock → B1 reject (the consumption write rolls back too) OR a non-fatal
  stage-for-review, TBD by Q3.
- **SEMI-AUTO (flag OFF)** = trigger A3: recording a consumption stages a pending
  `MaterialDeductionSuggestion` (no stock change); an operator confirms → CONSUME. This is the
  W4 returns flow verbatim.

Both paths converge on the SAME `RecordInventoryMovement(CONSUME, fromLocationId=tecnico)`
mutation, so the deduction logic is written once; the flag only decides *who pulls the trigger*
(the system inline vs. an operator in a review screen).

### D) IDEMPOTENCY — deduct ONCE per consumption

The consumption is the natural unit. Two complementary anchors (use both, defense-in-depth,
same as W4):

1. **`sourceRef = consume:task-material:{consumptionId}`** on the CONSUME movement +
   `findBySourceRef` pre-check + the PARTIAL UNIQUE → a re-deduct is a clean no-op/409.
2. **A link column on `TaskMaterialConsumption`** — `movementId` (the CONSUME's uuid) and/or
   `deductedAt`. Null = not yet deducted (the semi-auto "pending" signal AND the auto
   "already done" guard). This also powers the FE "deducted ✓ / pending" indicator and a
   `GetPendingDeductions` list (mirrors the existing `GetPendingSideEffectsList`).

> Editing/deleting a consumption AFTER it deducted must reverse or block — an open question
> (Q4). The cleanest: once `movementId` is set, the consumption is immutable (like the W4
> confirmed suggestion); a correction is a NEW compensating movement, never an in-place edit.

### E) THE MOVEMENT shape (settled)

```
RecordInventoryMovement.record({
  type: 'CONSUME',
  materialCatalogId: consumption.materialCatalogId,
  qty: consumption.quantity,
  fromLocationId: <technician TECNICO location id>,
  taskId: consumption.taskId,
  technicianId: task.assigneeId,
  source: 'TASK_CONSUMPTION',          // or 'ICLASS_MATERIAL' when channel 2
  sourceRef: `consume:task-material:${consumption.id}`,
})
```
Decrements the technician's `MaterialStock.qty` atomically. Reuses W1 entirely. Link back by
stamping `movementId` onto the consumption in the SAME UnitOfWork transaction.

---

## Recommendation (for the proposal phase to ratify)

1. **One toggle, two ends** — a `FeatureFlag` (`inventory-material-auto-deduct`, default OFF).
   OFF = semi-auto (stage a `MaterialDeductionSuggestion`, operator confirms — the W4 returns
   pattern verbatim). ON = auto (deduct inline at consumption-record time).
2. **Source = the task assignee's TECNICO location** via `ResolveTechnicianLocation`.
3. **Idempotency = `sourceRef` (`consume:task-material:{id}`) + a `movementId`/`deductedAt`
   link column** on `TaskMaterialConsumption` (the migration). Once deducted → immutable.
4. **Insufficient stock**: auto → reject (B1) by default; semi-auto → `needs_review` (B3).
   Depot fallback (B2) only behind a separate explicit flag, never silent.
5. **Build the shared CONSUME mutation once**; both ends call it. The semi-auto staging table +
   confirm use case + route + a small FE review screen are the bulk of the new surface.

This makes W6 a near-mechanical re-application of the W4 returns architecture, swapping
RETURN→CONSUME, asset→material, depot-target→technician-source. Low architectural novelty,
HIGH operational risk — which is the right risk profile to gate behind a default-OFF flag and
an operator confirm.

---

## Open Questions for the Human (decide in proposal)

- **Q1 — Trigger default**: ship default-OFF semi-auto (operator confirms each deduction) and
  let them flip on auto later? (Recommended — safest for a stock-mutating feature.)
- **Q2 — Source technician**: deduct from the **task's `assigneeId`** TECNICO stock (the
  person who did the job), correct? Not `recordedByUserId` (who keyed the consumption, maybe
  an office operator). Confirm.
- **Q3 — Insufficient stock** (technician never got it issued in W5a, TECNICO qty=0): reject
  (block the consumption), stage needs-review, or fall back to DEPOSITO? Recommend
  reject(auto)/needs-review(semi-auto); depot only behind an explicit flag.
- **Q4 — Edit/delete after deduction**: once a consumption deducted stock, is the consumption
  frozen (corrections = a new compensating movement), or do we reverse the CONSUME on
  edit/delete? Recommend freeze.
- **Q5 — IClass materials volume**: is `IClassSoMaterial` actually populated in prod, or are
  all material consumptions operator-keyed via `RecordMaterialConsumption`? (Doesn't change
  the design — both funnel through `TaskMaterialConsumption` — but sizes the auto-path blast
  radius.)
- **Q6 — Unassigned task**: a task with `assigneeId = null` has no TECNICO location. Reject the
  deduction, or fall back to depot? Recommend reject + surface in the review list.

---

## Risks

- **HIGH — wrong decrement = wrong physical count.** A mis-keyed qty or a double-fire silently
  corrupts the technician's stock. Mitigated by: default-OFF flag, semi-auto operator confirm,
  `sourceRef` idempotency, the foundation's negative-stock guard.
- **Channel asymmetry**: two consumption-creation paths (`RecordMaterialConsumption` +
  `ConfirmInventorySuggestion.handleMaterial`). Both must route through the SAME deduction —
  miss one and half the consumptions never deduct. (The DEVICE dual-write in
  `ConfirmInventorySuggestion` already proves the pattern; the MATERIAL branch is its missing
  twin.)
- **Source-location semantics drift**: B2 depot fallback makes "from the technician's stock"
  untrue. Keep it explicit and flagged.
- **Migration on a hot table**: adding a nullable `movementId`/`deductedAt` to
  `TaskMaterialConsumption` is additive/safe; all existing rows = NULL (= "never deducted",
  correct). No backfill of historical decrements (would double-count against current stock).
- **Idempotency index**: must be the hand-written PARTIAL UNIQUE (`WHERE sourceRef IS NOT
  NULL`), NOT a Prisma `@@unique` — the schema already documents this trap (`schema.prisma:956`).

## Ready for Proposal

**Yes.** The gap is confirmed (consumption records but doesn't decrement), the source channel
is confirmed (`TaskMaterialConsumption`, fed by both manual and IClass-material paths), and the
entire mechanism is a re-application of the shipped W4 returns architecture (stage →
operator-confirm → atomic sourceRef-guarded movement) with CONSUME-from-technician instead of
RETURN-to-depot. The human needs to answer Q1–Q6 (chiefly: default trigger, source technician,
and insufficient-stock handling) before specs.
