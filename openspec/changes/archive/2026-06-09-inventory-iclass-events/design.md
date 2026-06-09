# Design: Closure-Detected Equipment Returns to Depot (EPIC #38, Wave 4)

> **HIGH-RISK** — mutates stock. The whole architecture is built around *never*
> auto-mutating from a fuzzy external signal: closure only **stages**; an operator
> **confirms**; only the confirm fires the W1 `RETURN→DEPOSITO` ledger movement.
> Idempotency is two-layered (per-SO flag + movement `sourceRef`).

## Technical Approach

W4 has **two clean halves**, split exactly on the mutation boundary:

1. **Stage (read-only, automatic).** A new `processInventoryReturns` side-effect inside
   `IngestClosedServiceOrders.runClosureSideEffects` (alongside `inventoryBuilt`). It fires
   only when the SO is a completed RETIRO (result-code gate) and the per-SO
   `inventoryReturnsProcessed` flag is false. It reads the task's `OcrExtraction` serials,
   matches each against an `installed` `InventoryAsset`, and writes one `ReturnSuggestion`
   row per serial (`pending` if matched, `needs_review` if not). **It NEVER touches stock.**
2. **Confirm (mutation, operator-driven).** `ConfirmAssetReturn` takes a `ReturnSuggestion`,
   resolves the DEPOSITO singleton (`ResolveDepotLocation`), and runs ONE atomic
   `RecordInventoryMovement({type:'RETURN', assetId, toLocationId: depot})` inside a
   `UnitOfWork`. `computeAssetEffect(RETURN)` flips the asset to `available`@depot, and it
   surfaces in `GetDepotStock` (W3) for free. The suggestion goes `confirmed`.

This mirrors the proven #19 pattern (`TaskInventorySuggestion` → `ConfirmInventorySuggestion`)
but for the REMOVAL direction. No INSTALL movement is ever produced (installs stay owned by #19).

## Architecture Decisions

### D1 — Dedicated `ReturnSuggestion` model (not reuse `TaskInventorySuggestion`)

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Reuse `TaskInventorySuggestion` with `kind='RETURN'` | Fewer tables, but pollutes the #19 confirm path (it asserts `DEVICE\|MATERIAL`, resolves a contract, dual-writes a CII). RETURN has no CII, no contract, a *matched asset* instead of a *new device*. | **REJECTED** |
| New `ReturnSuggestion` model + `ConfirmAssetReturn` | One concern per table; the confirm logic is the inverse (find existing asset → RETURN), not create-on-contract. Mirrors #19's *shape* without overloading its *code*. | **CHOSEN** |

**Rationale:** the two flows share a UX *pattern* (stage → operator card → confirm/discard) but
NOT a domain shape. Overloading the #19 use case would fork it with `if kind==='RETURN'` branches
across an already-complex 460-line class. A sibling model keeps each confirm path single-purpose.

### D2 — Idempotency = two layers (per-SO flag PRIMARY + movement `sourceRef` DEFENSE)

| Layer | Mechanism | Stops |
|-------|-----------|-------|
| **L1 — staging** | `inventoryReturnsProcessed` boolean on `IClassServiceOrder` (mirrors `inventoryBuilt`); side-effect runs only when false, set true after staging | Re-closure / re-mirror re-staging duplicate suggestions |
| **L2 — confirm** | `sourceRef` natural key `iclass:return:{iclassId}:{serial}` + `@@unique` on `InventoryMovement`; the RETURN insert no-ops/throws-on-conflict | Double-confirm, re-confirm, two operators racing the SAME suggestion → double-return |

**Rationale:** L1 alone (the explore's "Option A") is enough to stop the *automatic* path from
re-staging, and matches the established side-effect pattern. But because this is HIGH-RISK and the
mutation is now *operator-triggered* (L1 doesn't guard a manual double-click), we ADD L2 at the
ledger grain — the explore's "Option B", which it flagged as the make-or-break hardening. A
re-confirm hits the unique constraint and is caught as "already returned" (idempotent no-op),
exactly like `ResolveDepotLocation`'s P2002 race handling. Defense-in-depth, not redundancy.

### D3 — Removal-code gate (configurable, seeded with the 2 confirmed codes)

The trigger is **NOT** SO-type alone (a `Cliente Ausente` retiro must stage nothing). Gate on
`resultCodeType === 'Sucesso'` **AND** the result-code name ∈ the removal set:

- `Retiro completo Servicio Fibra`
- `Retiro completo Servicio Wireless`

Make the set configurable via a new boolean column `isRemovalCode` on `IClassResultCode` (default
`false`, seed `true` for the 2 above). The side-effect resolves the code via the existing
`resolveResultCode(s)` and checks `rc?.isRemovalCode === true`. A constant set is the fallback if
the migration on `IClassResultCode` is deferred, but the **flag-on-the-row** is preferred: it lets
ops add codes without redeploy, consistent with the existing `mappedStageId` mapping UX.

### D4 — Serial→asset match (normalized, `installed`-only)

Match by `serialNumber`, but **normalized** to survive the #36 IClass/OCR drift (trim, uppercase,
strip non-alphanumerics). Add `findByNormalizedSerial(serial)` to `InventoryAssetRepository` (the
exact `findBySerialNumber` stays for #19). Only an asset with `status === 'installed'` is a valid
match — returning an `available`/`removed` asset is nonsensical. Resolution:

- **matched (1 installed asset)** → `pending`, `matchedAssetId` set.
- **no match / not installed** → `needs_review`, `matchedAssetId` null. Operator picks create / link / discard.
- **MAC fallback**: if SN misses, try `mac` (both are on the OCR extraction and the asset).

### D5 — Confirm resolutions (matched + the no-match escape hatches)

| Resolution | Action | Movement |
|------------|--------|----------|
| `return` (matched) | RETURN the `matchedAssetId` to depot | `RETURN`, asset→`available`@depot |
| `link` (no-match, operator picks an asset) | RETURN the chosen asset | `RETURN`, same |
| `create` (no-match, device pre-dates our system) | Create `InventoryAsset(status:'available', location:DEPOSITO, source:'ICLASS_RETIRO')` — born already-returned | NO movement (no prior location to move FROM); the create IS the depot entry |
| `discard` | Mark `discarded`, no stock change | none |

`create` never auto-fires (explore §6 — phantom stock risk); it is an explicit operator choice on a
`needs_review` row. All mutating resolutions run inside the `UnitOfWork` and stamp the `sourceRef`.

## Data Flow

```
                          IClass closure loop (IngestClosedServiceOrders)
                          ────────────────────────────────────────────────
  RETIRO SO closes ──► processSummary ──► runClosureSideEffects
                                                    │
                          (gate) rc.isRemovalCode && rc.type==='Sucesso'
                          (gate) !inventoryReturnsProcessed
                                                    │
                                                    ▼
                    StageReturnSuggestions(taskId, serviceOrderId)
                      reads OcrExtraction.sn/mac for the task
                      per serial → findByNormalizedSerial (installed only)
                          ├─ matched  → ReturnSuggestion(status=pending, matchedAssetId)
                          └─ no match → ReturnSuggestion(status=needs_review, matchedAssetId=null)
                      markSideEffect(inventoryReturnsProcessed = true)   ◄── L1 idempotency
                                                    │
                                NO STOCK MUTATION HAPPENS HERE
   ─────────────────────────────────────────────────────────────────────────────────────
                          Operator surface ("Devoluciones pendientes")
                                                    │
                       GET pending/needs_review ReturnSuggestions
                                                    │
                                 operator confirms ──► ConfirmAssetReturn
                                                    │
                                        ┌── UnitOfWork (atomic) ──┐
                                        │  ResolveDepotLocation    │
                                        │  RecordInventoryMovement │  ◄── sourceRef unique (L2)
                                        │    RETURN asset→DEPOSITO  │
                                        │  computeAssetEffect:      │
                                        │    installed→available    │
                                        │  suggestion → confirmed   │
                                        └───────────────────────────┘
                                                    │
                                                    ▼
                              asset available @ DEPOSITO ──► GetDepotStock (W3, free)
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modify | New `ReturnSuggestion` model; `inventoryReturnsProcessed Boolean @default(false)` on `IClassServiceOrder`; `isRemovalCode Boolean @default(false)` on `IClassResultCode`; `sourceRef String?` + `@@unique([sourceRef])` on `InventoryMovement` |
| `prisma/migrations/<ts>_iclass_returns/` | Create | Additive migration (new table + nullable columns + partial unique). No backfill. |
| `prisma/seed.ts` | Modify | Seed `isRemovalCode=true` for the 2 confirmed removal codes |
| `src/domain/entities/return-suggestion.ts` | Create | Entity + `createReturnSuggestion` factory + status/resolution unions |
| `src/domain/ports/ReturnSuggestionRepository.ts` | Create | `create`, `get`, `listPending`, `listByTask`, `setStatus`, `findBySourceRef` |
| `src/infrastructure/adapters/prisma/PrismaReturnSuggestionRepository.ts` | Create | Prisma adapter |
| `src/infrastructure/adapters/in-memory/InMemoryReturnSuggestionRepository.ts` | Create | In-memory adapter (tests) |
| `src/application/use-cases/StageReturnSuggestions.ts` | Create | Reads OCR serials → matches → stages suggestions (read-only) |
| `src/application/use-cases/ConfirmAssetReturn.ts` | Create | `return`/`link`/`create`/`discard` → atomic `RETURN` via `UnitOfWork` |
| `src/application/use-cases/IngestClosedServiceOrders.ts` | Modify | New `processInventoryReturns` side-effect block in `runClosureSideEffects`; new optional deps (`stageReturns`, `returns` repo); gate on `isRemovalCode` + `inventoryReturnsProcessed` |
| `src/domain/ports/ClosedServiceOrderRepository.ts` (+ both adapters) | Modify | Add `inventoryReturnsProcessed` to `ClosureSideEffect` union + state |
| `src/domain/ports/IClassResultCodeRepository.ts` (+ adapters) | Modify | Surface `isRemovalCode` on the resolved row |
| `src/domain/ports/InventoryAssetRepository.ts` (+ adapters) | Modify | Add `findByNormalizedSerial` |
| `src/domain/ports/InventoryMovementRepository.ts` (+ adapters) | Modify | Accept + persist `sourceRef`; conflict → idempotent no-op |
| `src/infrastructure/http/routes/serviceInventory.routes.ts` | Modify | `GET /returns/pending`, `POST /returns/:id/confirm`, `POST /returns/:id/discard` |
| `ipnext-frontend` (separate repo) | Create | "Devoluciones pendientes" list + confirm/create/link/discard card |

## Interfaces / Contracts

```ts
// domain/entities/return-suggestion.ts
export type ReturnSuggestionStatus = 'pending' | 'needs_review' | 'confirmed' | 'discarded';
export type ReturnResolution = 'return' | 'link' | 'create' | 'discard';

export interface ReturnSuggestion {
  id: string;
  taskId: string;
  serviceOrderId: string;        // IClass iclassId (for sourceRef + traceability)
  serialNumber: string | null;   // normalized OCR serial
  mac: string | null;
  deviceType: string | null;     // hint from the OCR label
  matchedAssetId: string | null; // null until/unless an installed asset matches
  status: ReturnSuggestionStatus;
  resolution: ReturnResolution | null; // set on confirm; null while pending
  confirmedMovementId: string | null;  // ledger row produced on confirm
  createdAt: string;
  updatedAt: string;
}
```

```prisma
model ReturnSuggestion {
  id             String        @id @default(uuid())
  taskId         String
  task           ScheduledTask @relation(fields: [taskId], references: [id], onDelete: Cascade)
  serviceOrderId String        // IClass iclassId
  serialNumber   String?
  mac            String?
  deviceType     String?
  matchedAssetId String?
  matchedAsset   InventoryAsset? @relation("ReturnMatchedAsset", fields: [matchedAssetId], references: [id], onDelete: SetNull)
  status         String   @default("pending") // pending | needs_review | confirmed | discarded
  resolution     String?  // return | link | create | discard
  confirmedMovementId String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@unique([serviceOrderId, serialNumber]) // one suggestion per (SO, serial) — dedup on re-stage
  @@index([status])
  @@index([taskId])
}
```

```ts
// The sourceRef format (L2 idempotency). Deterministic from SO + serial.
const sourceRef = `iclass:return:${serviceOrderId}:${normalizedSerial}`;
// RecordInventoryMovement input gains sourceRef; the adapter's record() catches
// P2002 on @@unique([sourceRef]) → returns the existing movement (idempotent).
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|--------------|----------|
| Unit (entity) | `createReturnSuggestion` defaults; status/resolution unions; normalize-serial helper | Pure functions |
| Unit (StageReturnSuggestions) | removal-code gate (Sucesso+isRemovalCode stages; Cliente Ausente stages nothing); matched→`pending`; no-match→`needs_review`; **never** records a movement; re-stage dedup via `@@unique` | In-memory repos |
| Unit (ConfirmAssetReturn) | matched `return` → 1 RETURN, asset `available`@depot; `link`; `create`-at-depot (no movement); `discard`; **double-confirm → idempotent no-op** (sourceRef); already-confirmed → reject | In-memory repos + in-memory `UnitOfWork` (rollback on throw) |
| Integration (IngestClosedServiceOrders) | RETIRO closure stages exactly one suggestion + sets `inventoryReturnsProcessed`; re-closure (same `iclassUpdatedAt`) re-stages nothing; non-removal retiro stages nothing; side-effect failure is non-fatal (mirror survives) | In-memory closure repos, fake IClass |
| E2E (route, supertest) | `GET /returns/pending` lists; `POST /confirm` fires RETURN, returns 200, asset in `GetDepotStock`; second `POST /confirm` → idempotent/409 | supertest on Express app, in-memory DI |

**Strict TDD:** red → green → refactor, starting from the StageReturnSuggestions gate test and the
ConfirmAssetReturn double-confirm test (the two highest-risk behaviors).

## Migration / Rollout

**Migration (additive, reversible, no backfill):**
1. `CREATE TABLE ReturnSuggestion` (+ indexes + `@@unique([serviceOrderId, serialNumber])`).
2. `ALTER TABLE IClassServiceOrder ADD inventoryReturnsProcessed BOOLEAN NOT NULL DEFAULT false`.
3. `ALTER TABLE IClassResultCode ADD isRemovalCode BOOLEAN NOT NULL DEFAULT false`.
4. `ALTER TABLE InventoryMovement ADD sourceRef TEXT NULL` + `CREATE UNIQUE INDEX ... ON InventoryMovement(sourceRef) WHERE sourceRef IS NOT NULL` (partial — existing rows have NULL, never collide).
5. Seed: set `isRemovalCode=true` for the 2 confirmed codes.

No backfill needed — staging is forward-only. Reversible by `DROP TABLE` + `DROP COLUMN`.

**Rollout (feature-flag-gated, default OFF):** `iclass-inventory-returns` flag gates whether
`processInventoryReturns` runs. Confirm endpoints are guarded by the same flag. Confirmed returns
are real ledger rows — to undo, record a compensating `INSTALL` back (append-only ledger; compensate,
never delete).

## Failure Modes (idempotency end-to-end)

| Scenario | Outcome |
|----------|---------|
| Re-mirror / re-closure of same SO | L1 flag true → side-effect skipped → no re-stage |
| Staging crashes AFTER writing some suggestions but BEFORE setting the flag | Next run re-runs staging; `@@unique([serviceOrderId, serialNumber])` makes already-staged serials no-op (create-if-missing); then flag set. No duplicates. |
| Operator double-clicks confirm | First confirm writes movement + `sourceRef`; second hits `@@unique([sourceRef])` → caught as idempotent no-op (movement already exists), suggestion already `confirmed` → reject second |
| Two operators confirm the SAME suggestion concurrently | One wins the `sourceRef` insert; the loser's P2002 resolves to the existing movement → no double-return |
| Confirm mid-transaction failure | `UnitOfWork` rolls back asset status + movement + suggestion status together — no orphan |
| `inventoryReturnsProcessed=true` but a 2nd device added to the SO later | Not re-staged (coarse, accepted — closures are terminal; matches `inventoryBuilt` behavior) |

## Open Questions

- [ ] FE: per-task panel vs a global "Devoluciones pendientes" page — design **recommends the global page** (mirror #35 pending-list) since returns are reviewed by depot/ops, not per-technician-task. Confirm with the human.
- [ ] `create`-at-depot needs a `deviceTypeId` — fall back to the `OTROS` catalog type (like #19's `dualWriteAsset`) when the OCR `deviceType` doesn't resolve. Confirm acceptable.
- [ ] Should `discarded` suggestions stay queryable (audit) or be hard-deleted? Recommend: keep (status flip), consistent with `TaskInventorySuggestion`.
