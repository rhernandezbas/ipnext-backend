# Tasks: Inventory — Vehicle Stock (EPIC #38 Wave 5b)

## Phase 1 — Schema + Migration

- [x] 1.1 Hand-author `prisma/migrations/20260614000000_inventory_vehicle_stock/migration.sql`: CREATE TABLE `Vehicle` (`id` TEXT PK, `plate` TEXT UNIQUE NOT NULL, `name` TEXT, `assignedTechnicianId` TEXT NULL REFERENCES `RbacUser`(id) ON DELETE SET NULL, `status` TEXT NOT NULL DEFAULT 'active', `createdAt` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, `updatedAt` TIMESTAMP(3) NOT NULL). Confirm no DB DEFAULT on `updatedAt` (schema↔SQL parity).
- [x] 1.2 In same migration.sql: ALTER TABLE `StockLocation` ADD COLUMN `vehicleId` TEXT NULL REFERENCES `Vehicle`(id) ON DELETE CASCADE; CREATE UNIQUE INDEX `StockLocation_type_vehicleId_key` ON `StockLocation`(`type`,`vehicleId`). Idempotent (wrap in DO $$ IF NOT EXISTS).
- [x] 1.3 Extend `prisma/schema.prisma`: add `Vehicle` model with all fields + relation to `StockLocation` (`locations`) + optional relation to `RbacUser` (`assignedTechnician`). Extend `StockLocation` with `vehicleId String?`, `vehicle Vehicle?` relation, `@@unique([type, vehicleId])`.
- [x] 1.4 Add `'CAMIONETA'` to `StockLocationType` enum in `prisma/schema.prisma`.
- [x] 1.5 Run `npx prisma generate` (no `prisma migrate`).

## Phase 2 — Domain

- [x] 2.1 Create `src/domain/entities/vehicle.ts`: `Vehicle` interface (`id, plate, name, assignedTechnicianId, status: 'active'|'inactive'`) + `createVehicle` factory (mirrors `createMaterialCatalog`).
- [x] 2.2 Modify `src/domain/entities/stock-location.ts`: add `'CAMIONETA'` to `StockLocationType` union + `VALID_TYPES`; add `vehicleId?: string | null` field; extend factory guard → throw `MissingLocationFkError` when `type === 'CAMIONETA' && !vehicleId`.
- [x] 2.3 Create `src/domain/ports/VehicleRepository.ts`: interface with `findById`, `findByPlate`, `list`, `create`, `update`, `delete`, `countLocationRefs`.
- [x] 2.4 Modify `src/domain/ports/StockLocationRepository.ts`: add `findByTypeAndVehicle(type: StockLocationType, vehicleId: string): Promise<StockLocation | null>`.
- [x] 2.5 Modify `src/domain/errors/inventory.ts`: add `VehicleNotFoundError` (404), `DuplicatePlateError` (409 `VEHICLE_PLATE_CONFLICT`), `VehicleInUseError` (409 `VEHICLE_IN_USE`), `VehicleInactiveError` (422 `VEHICLE_INACTIVE`).

## Phase 3 — Vehicle CRUD (TDD)

- [x] 3.1 Create `src/infrastructure/adapters/in-memory/InMemoryVehicleRepository.ts`: all 7 port methods (mirrors `InMemoryMaterialCatalogRepository`).
- [x] 3.2 Modify `src/infrastructure/adapters/in-memory/InMemoryStockLocationRepository.ts`: implement `findByTypeAndVehicle`.
- [x] 3.3 [RED] Write `src/__tests__/infrastructure/vehicles.routes.test.ts`: SCEN-VH-1 (create 201), SCEN-VH-2 (dup plate 409), SCEN-VH-3 (missing plate 400), SCEN-VH-4 (toggle status 200), SCEN-VH-5 (guarded delete 409), SCEN-VH-6 (safe delete 204), SCEN-VH-7 (list 403), SCEN-VH-8 (create 403). Supertest + in-memory repos.
- [x] 3.4 Create `src/application/use-cases/CreateVehicle.ts`: validate plate unique (findByPlate → DuplicatePlateError), create (clone `CreateMaterialCatalog`). [GREEN SCEN-VH-1, SCEN-VH-2, SCEN-VH-3]
- [x] 3.5 Create `src/application/use-cases/UpdateVehicle.ts`: findById → VehicleNotFoundError, patch status/name/assignedTechnicianId. [GREEN SCEN-VH-4]
- [x] 3.6 Create `src/application/use-cases/DeleteVehicle.ts`: findById → 404; countLocationRefs > 0 → VehicleInUseError; delete. [GREEN SCEN-VH-5, SCEN-VH-6]
- [x] 3.7 Create `src/application/use-cases/ListVehicles.ts` + `GetVehicle.ts`: list all / findById→404.
- [x] 3.8 Create `src/application/dto/vehicle.dto.ts`: zod `CreateVehicleSchema` (plate required) + `UpdateVehicleSchema` (status/name/assignedTechnicianId optional) + `VehicleDto` output type.
- [x] 3.9 Create `src/infrastructure/http/routes/vehicle.routes.ts`: `GET /` (read), `POST /` (manage), `PATCH /:id` (manage), `DELETE /:id` (manage). Map VehicleNotFoundError→404, DuplicatePlateError→409, VehicleInUseError→409. [GREEN SCEN-VH-7, SCEN-VH-8]

## Phase 4 — Stock Use Cases (TDD)

- [x] 4.1 [RED] Write `src/__tests__/application/ResolveVehicleLocation.test.ts`: SCEN-CL-1 (creates CAMIONETA location), SCEN-CL-2 (idempotent), SCEN-CL-3 (factory rejects null vehicleId → MissingLocationFkError). In-memory repos.
- [x] 4.2 Create `src/application/use-cases/ResolveVehicleLocation.ts`: `findByTypeAndVehicle('CAMIONETA', vehicleId)` → return if exists; else `stockLocations.create({ type:'CAMIONETA', vehicleId })` with P2002 retry-once. [GREEN SCEN-CL-1, SCEN-CL-2, SCEN-CL-3]
- [x] 4.3 [RED] Write `src/__tests__/application/GetVehicleStock.test.ts`: SCEN-GS-1 (stock with items → enriched DTO), SCEN-GS-2 (no location → empty DTO), SCEN-GS-3 (unknown vehicle → VehicleNotFoundError). In-memory repos.
- [x] 4.4 Create `src/application/use-cases/GetVehicleStock.ts`: findById→404; findByTypeAndVehicle→null→empty DTO; else fetch assets+materials+enrich (clone `GetTechnicianStock`). Create `src/application/dto/VehicleStockDto.ts` (vehicleId, assets, materials). [GREEN SCEN-GS-1, SCEN-GS-2, SCEN-GS-3]
- [x] 4.5 [RED] Write `src/__tests__/application/IssueStockToVehicle.test.ts`: SCEN-IS-1 (happy path asset+material), SCEN-IS-2 (vehicle not found 404), SCEN-IS-3 (inactive vehicle 422), SCEN-IS-4 (asset not at depot 409), SCEN-IS-5 (insufficient material 409). In-memory UoW.
- [x] 4.6 Create `src/application/use-cases/IssueStockToVehicle.ts`: findById→404; status guard→VehicleInactiveError; resolveDepot; resolveVehicle.execute(id); UoW tx per item TRANSFER. [GREEN SCEN-IS-1..5]

## Phase 5 — Routes + Wiring

- [x] 5.1 Create `src/infrastructure/adapters/prisma/PrismaVehicleRepository.ts`: all 7 port methods (clone `PrismaMaterialCatalogRepository`). `countLocationRefs` queries `StockLocation.count({ where: { vehicleId } })`.
- [x] 5.2 Modify `src/infrastructure/adapters/prisma/PrismaStockLocationRepository.ts`: implement `findByTypeAndVehicle` using compound unique key `type_vehicleId`.
- [x] 5.3 Modify `src/infrastructure/http/routes/inventory.routes.ts`: append `GET /vehicles/:id/stock` (read) + `POST /vehicles/:id/issue` (write) args at END of function signature (W6 ordering rule). Map VehicleNotFoundError→404, VehicleInactiveError→422, AssetNotAtDepotError→409, InsufficientStockError→409. [GREEN SCEN-IS-6, SCEN-GS-* route]
- [x] 5.4 Modify `src/infrastructure/http/app.ts`: wire `PrismaVehicleRepository`, `CreateVehicle`, `UpdateVehicle`, `DeleteVehicle`, `ListVehicles`, `GetVehicle` use cases; mount `createVehicleRouter` at `/api/vehicles`; extend `createInventoryRouter` call with new args (`GetVehicleStock`, `IssueStockToVehicle`, `ResolveVehicleLocation`).
- [x] 5.5 Modify `src/__tests__/infrastructure/inventory-composition-root.test.ts`: assert `GetVehicleStock` + `IssueStockToVehicle` wired into `createInventoryRouter`; assert `createVehicleRouter` mounted (FIX-FIRST if assertions missing).

## Phase 6 — Frontend

- [x] 6.1 Create `src/types/vehicle.ts` (FE): `Vehicle`, `VehicleStockDTO`, `IssueStockToVehicleRequest` types matching BE DTOs.
- [x] 6.2 Create `src/api/vehicles.ts`: `getVehicles`, `createVehicle`, `updateVehicle`, `deleteVehicle`, `getVehicleStock`, `issueStockToVehicle` API functions.
- [x] 6.3 Create `src/hooks/useVehicles.ts` + `useVehicleStock.ts` + `useIssueStockToVehicle.ts`: react-query wrappers (clone technician stock hooks).
- [x] 6.4 Create `src/pages/inventory/settings/VehiclesBody.tsx`: vehicle list table with plate, name, status badge, "Ver stock" link → `/admin/inventory/vehicles/:id`, "Agregar"/"Editar"/"Eliminar" controls gated by `inventory.manage` (SCEN-FE-1, SCEN-FE-2).
- [x] 6.5 Extend `src/pages/inventory/settings/InventorySettingsPage.tsx`: add "Camionetas" tab mounting `VehiclesBody` (alongside Equipos + Materiales tabs).
- [x] 6.6 Create `src/pages/inventory/InventoryVehiclePage.tsx`: fetch `useVehicleStock(id)`; render assets + materials tables; empty state if no stock (SCEN-FE-4); "Asignar stock" button hidden if lacking `inventory.write` (SCEN-FE-5).
- [x] 6.7 Create `src/components/inventory/AssignStockToVehicleModal.tsx`: sibling of `AssignStockToTechnicianModal`; hard-binds `vehicleId` + `useIssueStockToVehicle(vehicleId)`; never touches in-prod technician modal.
- [x] 6.8 Wire routes in FE router: `/admin/inventory/vehicles` (list/settings tab) + `/admin/inventory/vehicles/:id` → `InventoryVehiclePage`.
- [x] 6.9 Add "Camionetas" sidebar entry under Inventario section (SCEN-FE-3).
- [x] 6.10 Write `src/__tests__/VehiclesBody.test.tsx` + `InventoryVehiclePage.test.tsx` + `AssignStockToVehicleModal.test.tsx`: vitest + RTL; mock hooks; cover permission gating + empty state + happy path.

## Phase 7 — Verify

- [x] 7.1 Run `npx jest --runInBand` (BE): confirm all SCEN-VH-1..8, SCEN-CL-1..3, SCEN-GS-1..3, SCEN-IS-1..6 green; zero regressions.
- [x] 7.2 Run `npx tsc --noEmit` on BE: zero type errors.
## Fix wave (post-review)

- [x] FF-1 Route-level tests for vehicle stock/issue endpoints — `src/__tests__/infrastructure/inventory.routes.test.ts`: added `describe('Vehicle stock routes (EPIC #38 W5b)')` with 6 tests covering happy path issue (SCEN-IS-1), 403 without `inventory.write`, insufficient depot stock → 409 `INSUFFICIENT_DEPOT_STOCK` + atomic rollback (SCEN-IS-5), bad payload → 400, vehicle inactive → 422 `VEHICLE_INACTIVE` (SCEN-IS-3), GET unknown vehicle → 404 `VEHICLE_NOT_FOUND` (SCEN-GS-3). All red before → green after. Total tests: 2874 → 2882 pass.
- [x] FF-2 P2002 plate race → 409 — `src/infrastructure/http/routes/vehicle.routes.ts` `handleVehicleError`: added raw P2002 catch mapping to 409 `VEHICLE_PLATE_CONFLICT` (consistent with `DuplicatePlateError.code`). Covered by new test in `src/__tests__/infrastructure/vehicles.routes.test.ts` (FF-2 block): repo.create spied to throw `{code:'P2002'}` → expects 409 + `VEHICLE_PLATE_CONFLICT`.

- [ ] 7.3 Run `npx vitest run` + `npx tsc --noEmit` on FE: all SCEN-FE-1..5 tests green; zero type errors.
- [ ] 7.4 Confirm schema↔SQL parity: `updatedAt` in migration.sql has NO `DEFAULT`; `createdAt` has `DEFAULT CURRENT_TIMESTAMP`; `status` has `DEFAULT 'active'`; FK `vehicleId` ON DELETE CASCADE; `assignedTechnicianId` ON DELETE SET NULL.
- [ ] 7.5 Confirm no `prisma migrate` ran; only `npx prisma generate` + hand-authored migration file.
