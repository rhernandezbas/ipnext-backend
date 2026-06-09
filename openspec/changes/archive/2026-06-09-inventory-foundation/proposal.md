# Proposal: Inventory Foundation (EPIC #38, Wave 1)

## Intent

Two parallel inventory worlds coexist with no link between them: World A (`InventoryItem`/`InventoryProduct`/`InventoryUnit`, generic warehouse CRUD) and World B (`ContractInstalledItem` + material consumption, the live closure pipeline). The system has **no stock-location concept and no movement ledger** — the missing foundation for everything the epic needs (depot/per-client/per-technician stock, equipment return on removal, material deduction). Wave 1 settles the unification decision and lays the BE foundation: locations + a movement ledger + materialized balances, with FKs on everything.

## Scope

### In Scope
- **`StockLocation`** (new): `type` DEPOSITO|CLIENTE|TECNICO; typed nullable FKs (`contractId`→Contract for CLIENTE, `technicianId`→RbacUser for TECNICO; DEPOSITO = named singleton warehouse).
- **`InventoryAsset`** (new): unified serialized unit — `serialNumber`, `mac`, `deviceTypeId`→DeviceTypeCatalog, `status` (available|installed|removed|damaged|retired), `currentLocationId`→StockLocation, `source` (OCR|MANUAL|ICLASS), `sourceTaskId`→ScheduledTask.
- **`MaterialStock`** (new): `(materialCatalogId, locationId, qty)` consumable balance per location.
- **`InventoryMovement`** (new, the LEDGER): `type` ISSUE|TRANSFER|INSTALL|RETURN|CONSUME|ADJUST, `assetId?`, `materialCatalogId?`+`qty?`, `fromLocationId?`, `toLocationId?`, `taskId?`, `technicianId?`, `source`, `occurredAt`, `note`. FKs on all.
- **`RecordInventoryMovement`** use case: records a movement + atomically updates the materialized balance (asset location / material qty), with internal-consistency guard.
- **Migration**: create DEPOSITO; migrate 56 `ContractInstalledItem` → `InventoryAsset` (status installed, currentLocation = client's CLIENTE location, source preserved) + seed one INSTALL movement each. Keep `ContractInstalledItem` in sync so #19 confirm flow + FE keep working. Mark World A models DEPRECATED.

### Out of Scope
- Equipment-by-client page (W2), depot page (W3), IClass event consumption + remove→depot (W4), per-technician/truck + `Vehicle` model + CAMIONETA location (W5), material deduction from tasks (W6), unified dashboard (W7).
- Pushing movements to IClass (read-only model only). New FE (none/minimal in W1).

## Capabilities

### New Capabilities
- `stock-location`: location model (DEPOSITO|CLIENTE|TECNICO) with typed FKs + depot/client/technician resolution.
- `inventory-asset`: unified serialized-equipment unit; target of the ContractInstalledItem migration.
- `material-stock`: per-location consumable balance.
- `inventory-movement-ledger`: immutable movement audit trail + `RecordInventoryMovement` ledger primitive with transactional balance update.
- `inventory-balance-derivation`: materialized-balance contract (live truth in asset.currentLocationId + MaterialStock.qty; ledger = audit log).

### Modified Capabilities
- `service-inventory-management`: `ContractInstalledItem` becomes a projection of / kept in sync with `InventoryAsset`-at-client; confirm flow may write through to the new core, but operator UX/contract is unchanged.

## Approach

**Strategy 3 — Fresh unified core.** Justified by prod data: World A is **empty scaffolding** (`InventoryItem`/`InventoryProduct`/`InventoryUnit` = **0 rows in prod**) → zero migration cost to deprecate it. World B is live (`ContractInstalledItem`=56, `TaskInventorySuggestion`=141, `MaterialCatalog`=7, `TaskMaterialConsumption`=4, `DeviceTypeCatalog`=5) → must not break. So we build a clean `InventoryAsset` core, migrate only the 56 live items in, and deprecate the empty World A. This avoids the "one device, two rows" duplication that a bridge strategy would enshrine. `DeviceTypeCatalog` stays as the asset taxonomy. The battle-tested #19 confirm path's behavior is preserved (it may write through to the core, but operator contract/UX is untouched).

**Balance derivation — recommend MATERIALIZED.** `InventoryAsset.currentLocationId` + `MaterialStock.qty` are the live truth, updated transactionally by each movement; the ledger is the immutable audit trail. Tradeoff: a write must update two places atomically (movement + balance) → slightly more write logic, but reads never recompute the full ledger. Ledger-derived (recompute from movements per read) is rejected: O(ledger) reads and growing cost. Settle final mechanism in design.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | New | `StockLocation`, `InventoryAsset`, `MaterialStock`, `InventoryMovement`; deprecate World A models |
| `prisma/migrations/` | New | Schema migration (FKs) + data migration (DEPOSITO + 56 items + INSTALL movements) |
| `src/domain/entities/`, `src/domain/ports/` | New | Entities + repository ports for location/asset/stock/movement |
| `src/application/use-cases/` | New | `RecordInventoryMovement` + balance/query use cases |
| `src/infrastructure/adapters/prisma/` + `in-memory/` | New | Prisma + in-memory repos (TDD convention) |
| `ConfirmInventorySuggestion` / `ContractInstalledItem` flow | Modified | Kept in sync with new core; behavior unchanged |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Breaking the live #19 closure confirm path | Med | Keep `ContractInstalledItem` in sync; preserve its UX/contract; cover with existing + new tests |
| Movement/balance drift (non-atomic update) | Med | Wrap movement + balance update in one transaction; consistency guard in `RecordInventoryMovement` |
| `ContractInstalledItem`-as-projection mechanism unsettled | Med | Defer exact mechanism (FK link vs sync vs DB view) to design |
| IClass events not persisted today (`IClassSoEquipmentEvent`=0) | Low | Flag as W4 prerequisite to investigate; OUT of W1 scope |
| DEPOSITO singleton representation ambiguous | Low | Settle in design (named singleton vs flagged row) |

## Rollback Plan

New models/ledger are additive; no existing table is dropped (World A only marked deprecated). Revert: drop the new migration (removes `StockLocation`/`InventoryAsset`/`MaterialStock`/`InventoryMovement` + the data migration) and revert the `ContractInstalledItem` sync hook. The live closure path keeps working because `ContractInstalledItem` is never structurally changed in W1.

## Dependencies

- Prod confirmation (done): World A = 0 rows; World B counts as above.
- W4 prerequisite (OUT of scope): investigate why `IClassSoEquipmentEvent` is not persisted today.

## Success Criteria

- [ ] `StockLocation`, `InventoryAsset`, `MaterialStock`, `InventoryMovement` exist with FKs; migration applies cleanly.
- [ ] DEPOSITO seeded; 56 `ContractInstalledItem` migrated to `InventoryAsset` (installed, at CLIENTE) + 1 INSTALL movement each.
- [ ] `RecordInventoryMovement` updates the materialized balance atomically; consistency guard rejects inconsistent movements (TDD, in-memory ports, no Prisma mocks).
- [ ] Existing #19 confirm flow + FE unchanged in behavior (regression tests green).
- [ ] World A models marked deprecated; no live writer left.
