# Design: Inventory Foundation (EPIC #38, Wave 1)

## Technical Approach

Strategy 3 — a fresh unified core layered over the live closure pipeline **without rewriting it**.
We add four models (`StockLocation`, `InventoryAsset`, `MaterialStock`, `InventoryMovement`) plus the
`RecordInventoryMovement` ledger primitive. `ContractInstalledItem` (CII) stays canonical for the
per-client roster; each CII gains an `assetId` FK and is **dual-written** from the #19 flow. The asset is
the unified ledger record; CII is the operator/FE projection. World A (`InventoryItem/Product/Unit`,
0 prod rows) is marked deprecated, not dropped. Hexagonal throughout: new ports in `domain/ports`,
Prisma + in-memory adapters, application never imports infrastructure.

## Architecture Decisions

### D1 — CII ↔ InventoryAsset mechanism → **Option (a): ADD `assetId` FK + dual-write**

| Option | Tradeoff | Decision |
|---|---|---|
| (a) `assetId` FK on CII, dual-write from #19 | CII stays canonical roster; minimal change to live path; asset feeds ledger; one extra insert per confirm | **CHOSEN** |
| (b) Full migration, CII becomes a DB view | Cleanest end-state but rewrites ConfirmInventorySuggestion + replace() on live prod; FE-breaking risk | Rejected (live-path risk) |
| (c) CII canonical, asset only for depot/tech | Leaves client-installed devices out of the ledger → defeats the unified-asset goal | Rejected |

**Rationale**: (a) is the only option that keeps the battle-tested #18/#19 confirm/replace path structurally
intact while still giving every installed device a unified `InventoryAsset` row + an INSTALL movement for the
ledger. CII remains the source of truth the FE already reads; the asset is additive.

**ConfirmInventorySuggestion write path AFTER the change** (DEVICE/add branch; `replace()` is analogous):

```
1. asset = assetRepo.create({ id, serialNumber, mac, deviceTypeId(type), status:'installed',
                              currentLocationId: clienteLoc(contractId), source, sourceTaskId })
2. item  = inventory.create({ ...same as today..., assetId: asset.id })   // CII keeps its shape + gains assetId
3. movement.record({ type:'INSTALL', assetId: asset.id, toLocationId: clienteLoc, taskId, source })
   // RecordInventoryMovement sets asset.currentLocationId = toLocationId atomically
4. suggestions.setStatus('confirmed', item.id, ...)
```

Steps 1–3 are wrapped so a failed asset/movement insert does not leave a CII without an asset (see D2).
`replace()` additionally emits a `RETURN`/`removed` transition for the retired item's asset (status `removed`).
The ledger primitive is the SAME `RecordInventoryMovement` use case the rest of the epic uses.

### D2 — `RecordInventoryMovement` transactionality → **Prisma `$transaction`, balance update inside**

The movement insert + the materialized-balance write (`asset.currentLocationId` for serialized, or
`MaterialStock.qty` upsert for consumable) MUST be atomic. Port shape:

```ts
// domain/ports/InventoryMovementRepository.ts
interface RecordMovementInput {
  type: 'ISSUE'|'TRANSFER'|'INSTALL'|'RETURN'|'CONSUME'|'ADJUST';
  assetId?: string; materialCatalogId?: string; qty?: number;
  fromLocationId?: string; toLocationId?: string;
  taskId?: string; technicianId?: string; source: string; note?: string; occurredAt?: string;
}
interface InventoryMovementRepository {
  record(input: RecordMovementInput): Promise<InventoryMovement>; // atomic: movement + balance
}
```

- **Prisma adapter**: `prisma.$transaction(async tx => { create movement; then update balance })`.
  Serialized → `tx.inventoryAsset.update({ currentLocationId: toLocationId })`. Consumable → upsert
  `MaterialStock(materialCatalogId, locationId)` with `qty` increment/decrement.
- **Negative-qty guard (reject BEFORE any write)**: validate in the use case — for CONSUME/ISSUE that
  decrement `MaterialStock`, read current qty inside the tx; if `current - qty < 0` throw
  `InsufficientStockError` and roll back (no movement persisted). qty must be `> 0`; XOR guard:
  exactly one of (`assetId`) / (`materialCatalogId` + `qty`) is set.
- **In-memory adapter mirrors atomicity**: `record()` validates first, then mutates the in-memory
  movement list AND the balance map in one synchronous block; on guard failure it throws before mutating
  either → tests see all-or-nothing without a real DB. (Same pattern RecordMaterialConsumption uses today.)

### D3 — DEPOSITO singleton + per-entity locations

| Concern | Decision |
|---|---|
| DEPOSITO | A **seeded `StockLocation` row** with stable `code = 'DEPOSITO'` (unique). Resolved by code, not config — visible in DB, FK-able, one row. Seeded in the migration. |
| CLIENTE (per contract) | **Lazy**: created on first install for that `contractId` (find-or-create by `(type:'CLIENTE', contractId)`). Avoids 1 row per contract upfront. |
| TECNICO (per user) | **Lazy**, same pattern keyed by `technicianId`. Not exercised in W1 writes but modeled. |

`StockLocation`: `type` DEPOSITO|CLIENTE|TECNICO; nullable typed FKs `contractId→Contract`,
`technicianId→RbacUser`; `code String?` (DEPOSITO singleton); `@@unique([type, contractId])` and
`@@unique([type, technicianId])` enforce one CLIENTE per contract / one TECNICO per tech. CAMIONETA→W5.

### D4 — Material stock scope in W1 → **DEPOSITO-only**

`MaterialStock` is modeled generically `(materialCatalogId, locationId, qty)`, but W1 only seeds/operates
**DEPOSITO** balances. Per-technician / per-truck material stock is W5/W6. Rationale: W1's job is the
foundation + the 56-asset migration; material deduction from tasks is explicitly W6. Modeling the FK now
(locationId) means W5/W6 add rows, not columns. `TaskMaterialConsumption` stays as the consumption record;
it does NOT decrement stock in W1 (that wiring is W6).

### D5 — World A deprecation → **mark, don't drop**

Add `/// @deprecated W1 — superseded by InventoryAsset/MaterialStock; no live writer` doc comments on
`InventoryItem/Product/Unit`. Confirmed no live writer: only `EmpresaRepository` CRUD touches them, 0 prod
rows, `assignedToClientId` never set by any flow (per explore §2). Drop deferred to a later wave once the
6 `/inventory/*` FE pages are re-pointed. No new code writes World A after W1.

## Data Flow

```
#19 confirm (DEVICE)
  suggestion ──► ConfirmInventorySuggestion ──► InventoryAsset.create (status=installed)
                          │                              │
                          ├──► CII.create({assetId}) ◄───┘   (roster, FE reads this)
                          └──► RecordInventoryMovement(INSTALL, to=CLIENTE)
                                        │  $transaction
                                        ├─► InventoryMovement row (audit)
                                        └─► asset.currentLocationId = CLIENTE  (materialized truth)
```

## New Core — ASCII ER

```
DeviceTypeCatalog 1───* InventoryAsset *───1 StockLocation(currentLocationId)
                              │  ▲                    ├ type DEPOSITO|CLIENTE|TECNICO
                              │  │ assetId            ├ contractId? ──► Contract
ContractInstalledItem(+assetId)─┘                    └ technicianId? ──► RbacUser
                              │
InventoryMovement *──► InventoryAsset / from,toLocationId / taskId?──►ScheduledTask / technicianId?──►RbacUser
MaterialCatalog 1───* MaterialStock *───1 StockLocation     (qty per location; DEPOSITO-only in W1)
MaterialCatalog 1───* InventoryMovement (materialCatalogId? + qty?)
```

## File Changes

| File | Action | Description |
|---|---|---|
| `prisma/schema.prisma` | Modify | Add `StockLocation`, `InventoryAsset`, `MaterialStock`, `InventoryMovement`; add `assetId` FK on `ContractInstalledItem`; deprecate-comment World A |
| `prisma/migrations/<ts>_inventory_foundation/migration.sql` | Create | Schema DDL + idempotent data step (DEPOSITO seed, 56 CII→asset+INSTALL) |
| `src/domain/entities/{stock-location,inventory-asset,material-stock,inventory-movement}.ts` | Create | Domain entities |
| `src/domain/ports/{StockLocationRepository,InventoryAssetRepository,MaterialStockRepository,InventoryMovementRepository}.ts` | Create | Ports |
| `src/application/use-cases/RecordInventoryMovement.ts` | Create | Ledger primitive (atomic movement + balance, guards) |
| `src/application/use-cases/{ResolveDepotLocation,ResolveClientLocation}.ts` | Create | Location resolution (find-or-create) |
| `src/infrastructure/adapters/prisma/Prisma{StockLocation,InventoryAsset,MaterialStock,InventoryMovement}Repository.ts` | Create | Prisma adapters; movement adapter owns the `$transaction` |
| `src/infrastructure/adapters/in-memory/InMemory{...}Repository.ts` | Create | In-memory adapters (atomic mirror) |
| `src/domain/errors/inventory.ts` | Modify | Add `InsufficientStockError`, `InconsistentMovementError` |
| `src/application/use-cases/ConfirmInventorySuggestion.ts` | Modify | Dual-write asset + INSTALL movement; set CII.assetId |
| `src/infrastructure/http/app.ts` | Modify | Wire new repos into `ConfirmInventorySuggestion` + DI |
| `src/domain/entities/contract-installed-item.ts` + Prisma/in-memory CII repos | Modify | Add `assetId: string \| null` |

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit | `RecordInventoryMovement`: atomic balance update, negative-qty/XOR guards, each movement type | In-memory ports, no Prisma mocks (TDD red→green) |
| Unit | `ResolveDepot/ClientLocation` find-or-create idempotence | In-memory |
| Integration | #19 confirm/replace still green + now writes asset + INSTALL movement + CII.assetId | Existing supertest suites extended |
| Migration | 56 CII → 56 assets (installed, at CLIENTE) + 56 INSTALL movements; DEPOSITO exists; re-run is no-op | Apply on a copy; assert counts |

## Migration / Rollout

Single migration `migration.sql`, idempotent, safe under concurrent live #19 writes:

1. **DDL** — create the 4 tables + FKs; `ALTER TABLE "ContractInstalledItem" ADD COLUMN "assetId" TEXT` + FK (nullable).
2. **Seed DEPOSITO** — `INSERT ... WHERE NOT EXISTS (code='DEPOSITO')`.
3. **CLIENTE locations** — for each distinct `contractId` in CII with no CLIENTE location, insert one (`WHERE NOT EXISTS`).
4. **Assets** — for each CII without an `assetId`, insert an `InventoryAsset` (status `installed`,
   `currentLocationId` = that contract's CLIENTE loc, `serialNumber`/`mac`/`deviceTypeId`(from `type`)/
   `source`/`sourceTaskId` preserved), then set `CII.assetId`. Guarded by `assetId IS NULL` → idempotent;
   a CII created by a concurrent confirm already has `assetId` set by the new code path, so it is skipped.
5. **INSTALL movements** — one per migrated asset with no prior movement (`WHERE NOT EXISTS` on
   `InventoryMovement(assetId, type='INSTALL')`), `toLocationId` = CLIENTE, `occurredAt` = CII.confirmedAt/createdAt.

Idempotency keys: `assetId IS NULL`, `WHERE NOT EXISTS` on each insert → re-running matches nothing.
**Rollback**: drop the migration (drops 4 tables + `assetId` column); CII is structurally unchanged so the
live path keeps working. No data loss in CII. World A untouched (only comments).

## Open Questions

- [ ] `deviceTypeId` derivation: CII.`type` is a catalog *name* (UPPERCASE) — asset stores `deviceTypeId` FK; migration resolves name→id via `DeviceTypeCatalog`, fallback to the `OTROS` row. Confirm `OTROS` exists in prod (it backs the confirm fallback already).
- [ ] `replace()` retired-item asset transition: emit `RETURN` to DEPOSITO or just mark asset `removed` in place? W1 leans `removed` in place (true return-to-depot is W4). Confirm.
