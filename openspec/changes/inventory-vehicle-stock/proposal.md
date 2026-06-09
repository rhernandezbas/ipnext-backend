# Proposal: Inventory — Vehicle Stock (EPIC #38 Wave 5b "Camioneta")

## Intent

W5a (inventario x técnico) is in prod. W5b clones it for vehicles (truck stock): operators manage a Vehicle catalog (ABM) and issue stock from the depot to a truck (DEPOSITO → CAMIONETA TRANSFER). The W1 ledger is location-agnostic, so this is an additive wave — no movement-semantics changes.

## Scope

### In Scope
- `Vehicle` domain entity + additive migration (new table; `StockLocation.vehicleId` nullable FK; `@@unique([type, vehicleId])`).
- `StockLocationType` += `'CAMIONETA'`; factory guard for `vehicleId`.
- `ResolveVehicleLocation`, `GetVehicleStock`, `IssueStockToVehicle` (sibling clones of W5a use cases).
- Vehicle CRUD: Create/Update/Get/List + status toggle + guarded hard Delete.
- Routes: `GET/POST /api/inventory/vehicles/:id/stock|issue`; `/api/vehicles` CRUD.
- FE: "Camionetas" settings tab (ABM), per-vehicle stock page, vehicles list page, sidebar entry.

### Out of Scope
- W6 deduction vehicle-fallback (TECNICO-only by design).
- Technician list page (deferred from W5a — follow-up, not W5b).
- IClass sync, vehicle assignment history.

## Capabilities

### New Capabilities
- `inventory-vehicle-stock`: Vehicle catalog (ABM), per-vehicle stock locations (CAMIONETA), and depot→vehicle stock issuance.

### Modified Capabilities
- None. (No prior inventory spec exists in `openspec/specs/`; W5a was not spec-tracked. W5b reuses W1 ledger semantics unchanged.)

## Approach

Mechanical clone of W5a (sibling use cases — Option 1). New `VehicleRepository` port (find/list/CRUD) + Prisma/InMemory adapters. Add `findByTypeAndVehicle` to `StockLocationRepository`. Vehicle CRUD follows the MaterialCatalog/DeviceTypeCatalog router pattern. `IssueStockToVehicle` reuses TRANSFER + existing depot guards (`AssetNotAtDepotError`); no FROM-vehicle path. URLs keyed by stable `:id`.

### Resolved Decisions
1. **Status**: `active | inactive` catalog-grade flag (no lifecycle machine).
2. **FE modal**: parameterize the W5a `AssignStockModal` via a target prop (`toTechnicianId | toVehicleId`) IF props allow a clean swap; else sibling modal — never churn the in-prod technician page.
3. **Technician list page**: OUT — follow-up.
4. **Issue guard**: `IssueStockToVehicle` requires `vehicle.status === 'active'` (cannot issue to inactive truck).
5. **URLs**: by `:id` (plate is mutable).
6. **Delete surface**: guarded hard DELETE — refuse with `VehicleInUseError` when a CAMIONETA location/stock references the vehicle (matches `DeleteMaterial` precedent: `countInUse > 0` throws). Status toggle covers "park a truck."
7. **`assignedTechnicianId`**: informational only — zero stock semantics in W5b (vehicle fallback is W6/future).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` + migration | New/Modified | Vehicle table; `StockLocation.vehicleId` + unique |
| `src/domain/entities/{stock-location,vehicle}.ts` | New/Modified | CAMIONETA + Vehicle entity |
| `src/domain/ports/{VehicleRepository,StockLocationRepository}.ts` | New/Modified | port + `findByTypeAndVehicle` |
| `src/application/use-cases/*Vehicle*` | New | resolve/get/issue + CRUD |
| `src/infrastructure/adapters/{prisma,in-memory}` | New/Modified | Vehicle + StockLocation adapters |
| `src/infrastructure/http/{routes,app}` | New/Modified | vehicle routes + wiring |
| FE pages/hooks/api/sidebar | New/Modified | ABM tab, stock + list pages, nav |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `@@unique([type, vehicleId])` collides existing NULL rows | Low | PG treats NULLs as distinct — safe; verify Prisma emits plain unique (NOT `NULLS NOT DISTINCT`) |
| `StockLocationType` union breaks exhaustive switches | Low | Factory uses if-chains; grep for `switch(type)` in apply |
| Composition-root test asserts wiring identifiers | Med | Update `inventory-composition-root.test.ts` assertions |
| Live `StockLocation` ALTER on push=prod | Low | Additive nullable column + FK ON DELETE CASCADE; idempotent migration |

## Rollback Plan

Migration is additive: revert by dropping `StockLocation.vehicleId` (no live data references it) and `Vehicle` table. App code lives behind new routes/use cases — removing wiring disables the feature without affecting W5a. No data backfill to undo.

## Dependencies

- W1 inventory ledger (in prod). W5a use cases as clone templates (in prod).

## Success Criteria

- [ ] Migration applies cleanly; W5a TECNICO/CLIENTE/DEPOSITO rows unaffected.
- [ ] Operator creates a vehicle and issues depot stock to it (TRANSFER ledger entry).
- [ ] `GetVehicleStock` returns the issued items; empty DTO (no 404) before any issuance.
- [ ] Issuing to an inactive vehicle is rejected; deleting an in-use vehicle is rejected.
- [ ] Permissions enforced: `inventory.read` (list/get), `inventory.write` (issue), `inventory.manage` (CRUD). TDD green.
