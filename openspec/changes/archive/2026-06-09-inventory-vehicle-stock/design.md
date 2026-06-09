# Design: Inventory — Vehicle Stock (EPIC #38 Wave 5b "Camioneta")

## Technical Approach

Mechanical clone of W5a (in prod) for a new location type `CAMIONETA`, plus a `Vehicle` catalog (ABM) cloned from the MaterialCatalog pattern. The W1 ledger is location-type agnostic (`computeAssetEffect` / `applyMaterialEffect` only move `currentLocationId`/balances by id), so issuance reuses TRANSFER + `AssetNotAtDepotError` unchanged — purely additive. Each layer mirrors a proven W5a/Material reference 1:1.

## Architecture Decisions

| Decision | Choice | Rationale (vs rejected) |
|----------|--------|------------------------|
| Issue use case | Sibling `IssueStockToVehicle` (clone W5a) | Clean symmetry; no edit to in-prod `IssueStockToTechnician`. Rejected generic `IssueStockToLocation` (refactor risk on prod). |
| Active guard | `vehicle.findById` + `status==='active'` check BEFORE the UoW | Fail-fast outside the tx like W5a resolves locations pre-tx; rejected in-tx check (wastes a tx). |
| Vehicle delete | Guarded hard DELETE: `findById`→404, then `countLocationRefs>0`→`VehicleInUseError`, else delete (clone `DeleteMaterial`) | Matches DeleteMaterial precedent exactly. No OTRO-style protected row for vehicles. |
| Status toggle | Via `UpdateVehicle` (`status` patch field) | No lifecycle machine; catalog-grade flag (Decision 1 in proposal). |
| Compound unique | Plain `@@unique([type, vehicleId])` (NO `NULLS NOT DISTINCT`) | PG treats NULLs as distinct → existing DEPOSITO/CLIENTE/TECNICO rows (vehicleId NULL) never collide. Prisma emits `type_vehicleId` compound lookup key. |
| FE modal | Sibling `AssignStockToVehicleModal` + `useIssueStockToVehicle` hook | The W5a modal hard-binds `technicianId` + `useIssueStock(technicianId)`; parameterizing would thread a discriminator through in-prod modal AND hook. Decision 2: never churn the prod technician page. |
| Vehicle list surface | List lives in the ABM tab (`VehiclesBody`) with a "Ver stock" link per row → `/admin/inventory/vehicles/:id` | Simplest consistent with explore (no separate picker page); avoids a second route. Sidebar "Camionetas" → settings tab. |

## Data Flow

    POST /api/inventory/vehicles/:id/issue
      → IssueStockToVehicle.execute(id, {items})
          vehicle = vehicles.findById(id)        ← 404 / 409-inactive (pre-tx)
          depot   = resolveDepot('DEPOSITO')
          vehLoc  = resolveVehicle.execute(id)   ← find-or-create CAMIONETA, P2002 retry
          uow.runInTransaction:  per item → TRANSFER depot→vehLoc  (atomic)

    GET /api/inventory/vehicles/:id/stock
      → GetVehicleStock: findByTypeAndVehicle('CAMIONETA', id) → empty DTO if null (no 404)

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modify | `Vehicle` model; `StockLocation.vehicleId String?` + relation + `@@unique([type, vehicleId])` |
| `prisma/migrations/20260614000000_inventory_vehicle_stock/migration.sql` | Create | Additive idempotent: CREATE TABLE Vehicle, plate UNIQUE, ALTER StockLocation ADD vehicleId, FK CASCADE, compound unique |
| `src/domain/entities/vehicle.ts` | Create | Entity + `createVehicle` factory |
| `src/domain/entities/stock-location.ts` | Modify | `'CAMIONETA'` in union+VALID_TYPES; `vehicleId` field; factory guard (CAMIONETA→vehicleId) |
| `src/domain/ports/VehicleRepository.ts` | Create | findById/findByPlate/list/create/update/delete/countLocationRefs |
| `src/domain/ports/StockLocationRepository.ts` | Modify | + `findByTypeAndVehicle(type, vehicleId)` |
| `src/domain/errors/inventory.ts` | Modify | VehicleNotFoundError(404), DuplicatePlateError(409), VehicleInUseError(409), VehicleInactiveError(409) |
| `src/application/use-cases/{ResolveVehicleLocation,GetVehicleStock,IssueStockToVehicle}.ts` | Create | Clones of the W5a trio |
| `src/application/use-cases/{CreateVehicle,UpdateVehicle,GetVehicle,ListVehicles,DeleteVehicle}.ts` | Create | CRUD (clone Material* CRUD) |
| `src/application/dto/{VehicleStockDto,vehicle.dto}.ts` | Create | DTOs + zod Create/Update schemas (never raw Prisma) |
| `src/infrastructure/adapters/prisma/{PrismaVehicleRepository,PrismaStockLocationRepository}.ts` | Create/Modify | Vehicle adapter; SL `findByTypeAndVehicle` via `type_vehicleId`, `create` writes vehicleId |
| `src/infrastructure/adapters/in-memory/{InMemoryVehicleRepository,InMemoryStockLocationRepository}.ts` | Create/Modify | parity adapters |
| `src/infrastructure/http/routes/vehicle.routes.ts` | Create | `/api/vehicles` CRUD (read/manage), error map 404/409 |
| `src/infrastructure/http/routes/inventory.routes.ts` | Modify | + GET `/vehicles/:id/stock` (read) + POST `/vehicles/:id/issue` (write); new args appended at END (W6 ordering) |
| `src/infrastructure/http/app.ts` | Modify | wire Vehicle repos+use cases; mount `createVehicleRouter` at `/api/vehicles`; extend `createInventoryRouter` args |
| `src/__tests__/infrastructure/inventory-composition-root.test.ts` | Modify | assert `GetVehicleStock`/`IssueStockToVehicle` in `createInventoryRouter` args |

## Interfaces / Contracts

```ts
export type StockLocationType = 'DEPOSITO' | 'CLIENTE' | 'TECNICO' | 'CAMIONETA';
export interface Vehicle { id: string; plate: string; name: string | null;
  assignedTechnicianId: string | null; status: 'active' | 'inactive'; }
export interface VehicleRepository {
  findById(id): Promise<Vehicle|null>; findByPlate(plate): Promise<Vehicle|null>;
  list(): Promise<Vehicle[]>; create(v): Promise<Vehicle>;
  update(id, patch): Promise<Vehicle|null>; delete(id): Promise<boolean>;
  countLocationRefs(id): Promise<number>; }  // CAMIONETA StockLocations referencing the vehicle
// VehicleStockDTO mirrors TechnicianStockDTO with root `vehicleId` instead of `technicianId`.
```

Schema↔SQL parity (W6 lesson): `updatedAt @updatedAt` → SQL column `"updatedAt" TIMESTAMP(3) NOT NULL` with **no DB default**; `createdAt @default(now())` → `DEFAULT CURRENT_TIMESTAMP`; `status @default("active")` → `DEFAULT 'active'`. FK `vehicleId` ON DELETE CASCADE; `assignedTechnicianId`→RbacUser ON DELETE SET NULL.

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Unit | factory guard, Resolve P2002 retry, GetVehicleStock empty/populated, IssueStockToVehicle (transfer/atomic-rollback/AssetNotAtDepot/**inactive→VehicleInactiveError**), CRUD + DeleteVehicle guard | InMemory ports (clone W5a tests + Material CRUD tests) |
| Integration | `/api/vehicles` CRUD 200/201/204/404/409; `/vehicles/:id/stock`+`/issue` perms read/write | supertest, in-memory repos |
| Composition-root | new Vehicle use cases wired into `createInventoryRouter`; vehicle router mounted | static-source assertions (extend existing test) |

No Prisma-adapter tests (W5a shipped none for the stock trio; mirror that).

## Migration / Rollout

Additive, no flag, no backfill, read-only until an operator issues. Rollback: drop `StockLocation.vehicleId` + `Vehicle` table; remove wiring.

## Open Questions

- [ ] Router mount order: `/api/vehicles` is a fresh top-level prefix with no overlap against existing `/api`-catch-alls (contracts/inventory mount at `/api/inventory` or `/api/...` specific) — mount alongside other top-level routers; no precedence conflict found.
