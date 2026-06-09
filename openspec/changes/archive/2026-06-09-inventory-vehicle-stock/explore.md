# Exploration: inventory-vehicle-stock (EPIC #38, Wave 5b — "Camioneta")

## Current State

### Domain entity — `src/domain/entities/stock-location.ts`

`StockLocationType` = `'DEPOSITO' | 'CLIENTE' | 'TECNICO'` (line 3). **CAMIONETA is NOT in the union** — the comment on line 8 says explicitly "CAMIONETA es W5". The `createStockLocation` factory validates CLIENTE → `contractId`, TECNICO → `technicianId`, and DEPOSITO → no FKs. Adding CAMIONETA requires adding a `vehicleId` field + a guard in the factory.

### Schema — `prisma/schema.prisma`

`StockLocation` model (around line 902):
- Columns: `id`, `type` (String, not a Postgres enum), `code?`, `contractId?`, `technicianId?`, `createdAt`, `updatedAt`.
- Unique indexes (from W1 migration `20260611000000_inventory_foundation/migration.sql` lines 84-87):
  - `@@unique([type, contractId])` → one CLIENTE per contract.
  - `@@unique([type, technicianId])` → one TECNICO per technician.
  - `@@unique(code)` → DEPOSITO singleton.
- No `vehicleId` column exists. **W5b must add it** via migration.
- No `Vehicle` model exists anywhere in the schema.
- The `type` column is `String` (not a Postgres CHECK or enum), so adding `'CAMIONETA'` as a new allowed value is **safe at the DB level** — no Postgres ALTER TYPE needed, just TypeScript union + factory guard.

### W5a reference implementation (already shipped in prod)

All three W5a use cases exist and are fully functional:

- `src/application/use-cases/ResolveTechnicianLocation.ts` — find-or-create TECNICO location per `technicianId`; P2002 race guard with one retry.
- `src/application/use-cases/GetTechnicianStock.ts` — read-only aggregate: resolves TECNICO location via `findByTypeAndTechnician`, calls `assets.listByLocation` + `materialStock.listByLocation`, maps to `TechnicianStockDto`. Returns empty DTO (no 404) when no TECNICO location exists.
- `src/application/use-cases/IssueStockToTechnician.ts` — operator-driven TRANSFER (DEPOSITO → TECNICO). Resolves both locations outside the tx; runs all items inside one `UnitOfWork.runInTransaction`. The ledger type is `TRANSFER` (NOT `ISSUE` — documented in JSDoc). Asset guard: must be `status === 'available'` AND `currentLocationId === depot.id`.

Routes in `src/infrastructure/http/routes/inventory.routes.ts`:
- `GET /api/inventory/technicians/:id/stock` — `inventory.read`
- `POST /api/inventory/technicians/:id/issue` — `inventory.write`

The router function `createInventoryRouter` receives use cases as args. W5b adds two more args (`getVehicleStock`, `issueStockToVehicle`) and two routes.

### Port — `src/domain/ports/StockLocationRepository.ts`

```ts
findByCode(code: string): Promise<StockLocation | null>;
findByTypeAndContract(type: string, contractId: string): Promise<StockLocation | null>;
findByTypeAndTechnician(type: string, technicianId: string): Promise<StockLocation | null>;
create(location: StockLocation): Promise<StockLocation>;
```

W5b needs `findByTypeAndVehicle(type: string, vehicleId: string): Promise<StockLocation | null>` added to the port (and both adapters: Prisma + InMemory).

### Movement semantics — no changes needed

`computeAssetEffect` (`src/domain/entities/inventory-asset-effect.ts`) handles TRANSFER by updating `currentLocationId` to `toLocationId` — it is **completely location-type agnostic** (line 35-37). A CAMIONETA location is just another `toLocationId`; no changes needed.

`RecordInventoryMovement` and `PrismaInventoryMovementRepository.applyMaterialEffect` (TRANSFER case: atomicDecrement from + increment at toLocation) are similarly agnostic. W5b reuses them identically to W5a.

### Vehicle CRUD — catalog ABM pattern

The closest pattern is `MaterialCatalog` / `DeviceTypeCatalog`:
- Settings route factory (`createMaterialTypeCatalogRouter`, `createDeviceTypeCatalogRouter`) receives use cases + `requirePerm` as args.
- Permission keys used: `requirePerm('inventory', 'read')` and `requirePerm('inventory', 'manage')`.
- Route prefix: `/api/settings/material-types`, `/api/settings/device-types`.
- Vehicle CRUD should use the same pattern: `/api/vehicles` with `inventory.manage` for mutations, `inventory.read` for list/get.

### FE current state

`InventorySettingsPage.tsx` — tab-based settings page with "Equipos" (DeviceTypesBody) and "Materiales" (MaterialsBody) tabs. A "Camionetas" tab would fit naturally here for the Vehicle CRUD ABM.

`InventoryTechnicianPage.tsx` — exists at `/admin/inventory/technicians/:id`. No technician picker/list nav entry exists (deferred comment inside the file: "There is no technician picker yet — the page is reached directly by id; a nav entry point is deferred to W5b").

Sidebar (`src/components/organisms/Sidebar/Sidebar.tsx`) — Inventario section has: Dashboard, Artículos, Productos, Suministro, Devoluciones, Descuentos pendientes, Configuración. No "Técnicos" or "Camionetas" entry. W5b should add a "Camionetas" entry linking to the per-vehicle stock page (and optionally a list).

`App.tsx` already has the `/admin/inventory/technicians/:id` route registered but no vehicle route.

### Composition-root test — `src/__tests__/infrastructure/inventory-composition-root.test.ts`

This test reads `app.ts` source as a string and asserts specific identifiers appear in use-case constructor args. W5b will add two new use cases wired into `createInventoryRouter` — the test's regex on `createInventoryRouter(...)` args will need a new assertion for `getVehicleStock` / `issueStockToVehicle`.

### W6 deduction flow — scope boundary

`ConfirmMaterialDeduction` uses `suggestion.technicianLocationId` (TECNICO). The deduction flow is **TECNICO-only** by design — it deducts from the technician's stock. Vehicle stock does NOT participate in W6 deduction. If a technician drives a vehicle, their personal TECNICO location is still used for deductions. Vehicle stock is a separate concept (ops-managed, not auto-deducted). **No W6 changes needed for W5b.**

---

## Affected Areas

### Backend — New files

| File | Reason |
|------|--------|
| `prisma/schema.prisma` | Add `Vehicle` model + `StockLocation.vehicleId` nullable FK + `@@unique([type, vehicleId])` |
| `prisma/migrations/YYYYMMDDNNNNNN_inventory_vehicle_stock/migration.sql` | Additive: CREATE TABLE Vehicle, ALTER TABLE StockLocation ADD COLUMN vehicleId, add FK + unique index |
| `src/domain/entities/stock-location.ts` | Add `'CAMIONETA'` to `StockLocationType`; add `vehicleId: string | null` field; add factory guard |
| `src/domain/entities/vehicle.ts` | New domain entity: `Vehicle { id, plate, name?, assignedTechnicianId?, status }` |
| `src/domain/ports/VehicleRepository.ts` | Port: `findById`, `findByPlate`, `list`, `create`, `update`, `delete` |
| `src/domain/ports/StockLocationRepository.ts` | Add `findByTypeAndVehicle(type, vehicleId)` |
| `src/domain/errors/inventory.ts` | Add `VehicleNotFoundError`, `VehiclePlateConflictError`, `VehicleInUseError` |
| `src/application/use-cases/ResolveVehicleLocation.ts` | Clone of `ResolveTechnicianLocation`, keyed by vehicleId + type CAMIONETA |
| `src/application/use-cases/GetVehicleStock.ts` | Clone of `GetTechnicianStock`, keyed by vehicleId; returns `VehicleStockDTO` |
| `src/application/use-cases/IssueStockToVehicle.ts` | Clone of `IssueStockToTechnician`, resolves CAMIONETA location |
| `src/application/use-cases/CreateVehicle.ts` | CRUD use case |
| `src/application/use-cases/UpdateVehicle.ts` | CRUD use case |
| `src/application/use-cases/DeleteVehicle.ts` | CRUD use case |
| `src/application/use-cases/GetVehicle.ts` | CRUD use case |
| `src/application/use-cases/ListVehicles.ts` | CRUD use case |
| `src/application/dto/VehicleStockDto.ts` | Mirror of `TechnicianStockDTO`, root field `vehicleId` instead of `technicianId` |
| `src/application/dto/vehicle.dto.ts` | CreateVehicleInput, UpdateVehicleInput, VehicleDTO |
| `src/infrastructure/adapters/prisma/PrismaVehicleRepository.ts` | Prisma adapter for Vehicle |
| `src/infrastructure/adapters/prisma/PrismaStockLocationRepository.ts` | Add `findByTypeAndVehicle` + update `create` to write `vehicleId` |
| `src/infrastructure/adapters/in-memory/InMemoryVehicleRepository.ts` | In-memory adapter for tests |
| `src/infrastructure/adapters/in-memory/InMemoryStockLocationRepository.ts` | Add `findByTypeAndVehicle` |
| `src/infrastructure/http/routes/inventory.routes.ts` | Add `GET /vehicles/:id/stock` and `POST /vehicles/:id/issue` |
| `src/infrastructure/http/routes/vehicle.routes.ts` | New CRUD router (mirrors materialTypeCatalog.routes.ts pattern) |
| `src/infrastructure/http/app.ts` | Wire Vehicle repos + use cases + mount vehicle router |

### Backend — Test files

| File | Reason |
|------|--------|
| `src/__tests__/application/ResolveVehicleLocation.test.ts` | Clone of ResolveTechnicianLocation tests |
| `src/__tests__/application/GetVehicleStock.test.ts` | Clone of GetTechnicianStock tests |
| `src/__tests__/application/IssueStockToVehicle.test.ts` | Clone of IssueStockToTechnician tests |
| `src/__tests__/application/CreateVehicle.test.ts` | CRUD tests |
| `src/__tests__/application/ListVehicles.test.ts` | CRUD tests |
| `src/__tests__/infrastructure/vehicle.routes.test.ts` | Route tests (CRUD + stock endpoints) |
| `src/__tests__/infrastructure/inventory-composition-root.test.ts` | **MODIFY** — add assertions for `getVehicleStock` / `issueStockToVehicle` wired into `createInventoryRouter` |

### Frontend — New files

| File | Reason |
|------|--------|
| `src/api/vehicle.api.ts` | `getVehicleStock`, `issueStockToVehicle`, `listVehicles`, CRUD calls |
| `src/hooks/useVehicleStock.ts` | Mirror of `useTechnicianStock` |
| `src/hooks/useIssueStockToVehicle.ts` | Mirror of issue hook |
| `src/hooks/useVehicles.ts` | React Query hook for vehicle list |
| `src/types/vehicle.ts` | `VehicleStockDTO`, `VehicleDTO`, `IssueStockPayload` (reuse existing type) |
| `src/pages/inventory/InventoryVehiclePage.tsx` + CSS | Clone of `InventoryTechnicianPage.tsx` |
| `src/pages/inventory/InventoryVehiclesPage.tsx` + CSS | Vehicle list/picker page (nav entry point) |

### Frontend — Modified files

| File | Reason |
|------|--------|
| `src/App.tsx` | Add routes `/admin/inventory/vehicles` and `/admin/inventory/vehicles/:id` |
| `src/components/organisms/Sidebar/Sidebar.tsx` | Add "Camionetas" nav entry under Inventario |
| `src/pages/inventory/InventorySettingsPage.tsx` | Add "Camionetas" tab + `VehiclesBody` component |
| `src/pages/inventory/settings/VehiclesBody.tsx` (new) | Vehicle CRUD form (plate, name, status) |

---

## Approaches

### 1. IssueStockToVehicle as a sibling use case (RECOMMENDED)

Create `IssueStockToVehicle` as a mechanical clone of `IssueStockToTechnician`, resolving CAMIONETA location instead of TECNICO. Separate `ResolveVehicleLocation` use case.

- **Pros**: Clean symmetry with W5a; each use case is independently testable; no breaking change to existing W5a use cases; clear intent at the call site.
- **Cons**: Some code duplication (2 nearly identical use cases). Could be reduced later with a generic `IssueStockToLocation` if needed.
- **Effort**: Medium (follows W5a template exactly).

### 2. Generalize IssueStockToLocation (accepts a `locationId` directly)

Extract a generic `IssueStockToLocation(fromLocationId, toLocationId, items)` and build `IssueStockToTechnician` and `IssueStockToVehicle` as thin adapters.

- **Pros**: Zero duplication; reusable for future location types (W7, etc.).
- **Cons**: Requires refactoring existing W5a use case (risk: in prod); the resolve logic is embedded in the concrete use cases; the port `findByTypeAndVehicle` is still needed regardless; over-engineering for current scope.
- **Effort**: High (refactor + regression risk).

### 3. Generalize IssueStockToTechnician to accept vehicleId OR technicianId

Add an overload or a `targetLocationType` discriminator.

- **Pros**: One use case instead of two.
- **Cons**: Violates Single Responsibility (two concerns in one use case); confusing for future devs; breaks the clean W5a → W5b separation.
- **Effort**: Low but messy.

### Recommendation

**Option 1 — sibling use case.** W5b is explicitly scoped as a clone of W5a. The two domains (truck vs person) are likely to diverge (vehicle status transitions, plate-based queries, reassignment tracking). Keep them separate.

---

## Open Questions for the Proposal Phase

1. **Should `IssueStockToVehicle` require vehicle assignment to a specific technician?** — e.g., refuse to issue if `vehicle.assignedTechnicianId` is null. Or is a free-floating truck valid?
2. **Vehicle status lifecycle** — is `active | inactive` sufficient, or do we need `in_service | depot | retired`? Does status affect whether stock can be issued?
3. **Plate as the natural business key** — unique, but operators may need to search by plate. Should `ListVehicles` support plate-prefix filter?
4. **Does W5b include a technician-picker nav entry?** — W5a deferred the technician list. W5b is the right moment to add "Camionetas" as a list page (pick a vehicle → see its stock). Should W5b also add the technician list as a sidebar entry (for technician stock)?
5. **`AssetNotAtVehicleError` vs reuse `AssetNotAtDepotError`** — for issuing from vehicle: do we ever issue FROM a vehicle (back to depot)? If yes, we need a guard for "not at vehicle." If no (vehicle stock is always issued FROM depot), the existing `AssetNotAtDepotError` covers it.
6. **W6 vehicle fallback** — should W6 deductions ever fall back to vehicle stock if a technician's TECNICO location is empty but they have a CAMIONETA? Explicitly out of scope for W5b, but the proposal should call it out.
7. **FE: reuse `AssignStockModal` for vehicles?** — the modal currently issues FROM depot TO a technician. Can it be parameterized (receives `toTechnicianId` | `toVehicleId`)? Or is a new `AssignStockToVehicleModal` cleaner?

---

## Risks

1. **Migration on live `StockLocation` table**: adding `vehicleId` nullable column is a safe additive migration (`ALTER TABLE StockLocation ADD COLUMN "vehicleId" TEXT`). The unique index `@@unique([type, vehicleId])` must use a PARTIAL index (`WHERE "vehicleId" IS NOT NULL`) — otherwise all rows with `vehicleId = NULL` would collide (same pattern as the W4 sourceRef partial index). This is **CRITICAL**: do NOT use a plain `@@unique([type, vehicleId])` without handling NULLs in SQL. In PostgreSQL, NULL ≠ NULL in unique constraints, so plain @@unique is actually safe — but verify before shipping.

2. **Prisma `@@unique([type, vehicleId])` and NULLs**: PostgreSQL treats NULLs as distinct in unique constraints, so `@@unique([type, vehicleId])` would allow multiple rows with `vehicleId = NULL`. This is the CORRECT behavior (DEPOSITO, CLIENTE, TECNICO rows all have `vehicleId = NULL` and should not collide). Confirm this is what Prisma generates vs a NULLS NOT DISTINCT constraint.

3. **`StockLocationType` TypeScript union expansion**: adding `'CAMIONETA'` to the union may cause exhaustive switch errors in existing code. Check for any `switch (location.type)` or similar exhaustive patterns. Currently `createStockLocation` uses if-chains (not switch), so no exhaustive-check issue there. Review `PrismaStockLocationRepository.toEntity` — it casts `r.type as StockLocationType` which is safe (additive).

4. **Composition-root test**: `inventory-composition-root.test.ts` reads `app.ts` source and asserts specific identifiers. Adding new wiring must be done carefully, and the test must be updated to assert the new wiring exists.

5. **`findByTypeAndVehicle` compound key**: the prisma client will need a generated compound lookup `{ type_vehicleId: { type, vehicleId } }` (same pattern as `type_technicianId`). This only works if the `@@unique([type, vehicleId])` is in the schema. Verify Prisma generates the compound unique name correctly.

6. **FE: no vehicle list endpoint yet** — `AssignStockModal` for vehicles needs a picker. The vehicle list endpoint needs to be created. Confirm whether vehicle list is in scope for W5b.

---

## Migration Shape

```sql
-- Additive migration: new Vehicle table + vehicleId FK on StockLocation
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "plate" TEXT NOT NULL,
    "name" TEXT,
    "assignedTechnicianId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Vehicle_plate_key" ON "Vehicle"("plate");
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_assignedTechnicianId_fkey"
    FOREIGN KEY ("assignedTechnicianId") REFERENCES "RbacUser"("id") ON DELETE SET NULL;

-- Add vehicleId FK to StockLocation (nullable, additive)
ALTER TABLE "StockLocation" ADD COLUMN "vehicleId" TEXT;
ALTER TABLE "StockLocation" ADD CONSTRAINT "StockLocation_vehicleId_fkey"
    FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE;

-- Unique: one CAMIONETA per vehicle
-- PostgreSQL NULLs are distinct, so this does NOT affect existing rows with vehicleId=NULL.
CREATE UNIQUE INDEX "StockLocation_type_vehicleId_key" ON "StockLocation"("type", "vehicleId");
```

No data backfill needed (Vehicle table is new, no live vehicle data exists).

---

## Ready for Proposal

Yes. The scope is fully unblocked once the migration lands. All application-layer primitives have clear W5a counterparts to clone. Key decisions for the proposal:

1. Confirm sibling use case approach (Option 1).
2. Confirm vehicle CRUD minimal surface (plate + name + assignedTechnicianId + status).
3. Clarify whether IssueStockToVehicle source is always DEPOSITO (or can vehicle issue to vehicle, or vehicle return to depot).
4. Decide whether `AssignStockModal` is reused with a param or a new modal is created for vehicles.
5. Decide whether W5b includes a sidebar "Técnicos" list page (deferred from W5a) alongside "Camionetas."
