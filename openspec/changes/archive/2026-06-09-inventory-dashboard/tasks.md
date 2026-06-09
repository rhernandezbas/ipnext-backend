# Tasks: Inventory Dashboard (EPIC #38 Wave 7 — Capstone)

## Phase 1 — Migration + Schema

- [x] 1.1 Create `prisma/migrations/20260615000000_inventory_dashboard/migration.sql`: `ALTER TABLE "MaterialCatalog" ADD COLUMN IF NOT EXISTS "minStock" INTEGER NOT NULL DEFAULT 0;` + `CREATE INDEX IF NOT EXISTS "InventoryMovement_type_occurredAt_idx" ON "InventoryMovement"("type","occurredAt" DESC);` — NO drops, idempotent
- [x] 1.2 Update `prisma/schema.prisma`: add `minStock Int @default(0)` to `MaterialCatalog`; add `@@index([type, occurredAt])` to `InventoryMovement`
- [x] 1.3 Run `npx prisma generate` (no migrate — migration file already exists); verify no TS errors in generated client

## Phase 2 — Ports + DTOs

- [x] 2.1 Add `minStock: number` to `src/domain/entities/material-catalog.ts`
- [x] 2.2 Add `listWithContent(): Promise<LocationContent[]>` + `LocationContent` interface to `src/domain/ports/StockLocationRepository.ts`
- [x] 2.3 Add `listMovements(filters: MovementFilters, page: number, limit: number): Promise<{ items: InventoryMovement[]; total: number }>` + `MovementFilters` interface to `src/domain/ports/InventoryMovementRepository.ts`
- [x] 2.4 Add `listLowStock(): Promise<LowStockAlertDTO[]>` to `src/domain/ports/MaterialCatalogRepository.ts`
- [x] 2.5 Create `src/application/dto/InventoryOverviewDto.ts` — `OverviewLocationDTO`, `OverviewGroupDTO`, `InventoryOverviewDTO` (all 4 types always present)
- [x] 2.6 Create `src/application/dto/InventoryMovementListDto.ts` — `MovementRowDTO`, `InventoryMovementListDTO`
- [x] 2.7 Create `src/application/dto/StockAlertDto.ts` — `LowStockAlertDTO` with `deficit: number`
- [x] 2.8 Update `src/application/dto/inventory.dto.ts`: add `minStock: z.number().int().min(0)` to Create/Update schemas + `minStock: number` to `MaterialCatalogDto`

## Phase 3 — Use Cases (Strict TDD: RED → GREEN per pair)

- [x] 3.1 [RED] Write `src/__tests__/application/GetInventoryOverview.test.ts` — SCEN-LOC-1 (mixed, correct labels, TECNICO excluded), SCEN-LOC-2 (empty list); uses `InMemoryStockLocationRepository`
- [x] 3.2 [GREEN] Create `src/application/use-cases/GetInventoryOverview.ts` — calls `StockLocationRepository.listWithContent()`, groups into `InventoryOverviewDTO` (all 4 types, empty → count 0); tests pass
- [x] 3.3 [RED] Write `src/__tests__/application/ListInventoryMovements.test.ts` — SCEN-MOV-1 (paging defaults), SCEN-MOV-2 (page 2), SCEN-MOV-3 (filter type), SCEN-MOV-4 (locationId), SCEN-MOV-5 (date range), SCEN-MOV-6 (combined), SCEN-MOV-7 (empty)
- [x] 3.4 [GREEN] Create `src/application/use-cases/ListInventoryMovements.ts` — batch-resolves labels by unique id (materialMap, locationMap, userMap, taskMap); returns `InventoryMovementListDTO`; tests pass
- [x] 3.5 [RED] Write `src/__tests__/application/GetLowStockAlerts.test.ts` — SCEN-ALT-1 (below threshold, deficit math), SCEN-ALT-2 (at/above excluded), SCEN-ALT-3 (minStock=0 never alerts); multi-location SUM
- [x] 3.6 [GREEN] Create `src/application/use-cases/GetLowStockAlerts.ts` — delegates entirely to `MaterialCatalogRepository.listLowStock()`; tests pass
- [x] 3.7 [RED] Add SCEN-MS-1 (update minStock), SCEN-MS-2 (negative → 400) to existing `src/__tests__/application/UpdateMaterial.test.ts` (or equivalent)
- [x] 3.8 [GREEN] Update `src/application/use-cases/UpdateMaterial.ts` + `CreateMaterial.ts` — pass-through `minStock`; validate ≥ 0; tests pass

## Phase 4 — InMemory Adapters + Prisma Adapters (parity)

- [x] 4.1 Implement `listWithContent()` in `src/infrastructure/adapters/in-memory/InMemoryStockLocationRepository.ts` — filters locations with assetCount > 0 OR materialQty > 0; resolves label from stored test-only fields
- [x] 4.2 Implement `listMovements()` in `src/infrastructure/adapters/in-memory/InMemoryInventoryMovementRepository.ts` — filters, offset pagination, `occurredAt DESC`
- [x] 4.3 Implement `listLowStock()` in `src/infrastructure/adapters/in-memory/InMemoryMaterialCatalogRepository.ts` — SUM(stock.qty) per material, filter minStock > 0 AND SUM < minStock
- [x] 4.4 Implement `listWithContent()` in `src/infrastructure/adapters/prisma/PrismaStockLocationRepository.ts` — ONE Prisma pass: groupBy + selective include for labels (contract.client, technician, vehicle)
- [x] 4.5 Implement `listMovements()` in `src/infrastructure/adapters/prisma/PrismaInventoryMovementRepository.ts` — ONE `findMany` + ONE `count`; filters mapped to `where` clause; `occurredAt DESC`
- [x] 4.6 Implement `listLowStock()` in `src/infrastructure/adapters/prisma/PrismaMaterialCatalogRepository.ts` — `groupBy materialCatalogId` on `MaterialStock`, SUM qty, filter `minStock > 0 AND SUM < minStock`; join material name/unit

## Phase 5 — Routes + Wiring

- [x] 5.1 Add `MovementsQuery` Zod schema + 3 GET handlers (`/overview/locations`, `/movements`, `/alerts`) to `src/infrastructure/http/routes/inventory.routes.ts` — args appended LAST per W6 rule; guarded with `inventory.read` permission; Zod validation returns 400 on bad input
- [x] 5.2 Wire `GetInventoryOverview`, `ListInventoryMovements`, `GetLowStockAlerts` into `createInventoryRouter(...)` call in `src/infrastructure/http/app.ts` (append to existing args, mirrors existing pattern)
- [x] 5.3 [RED] Write/update `src/__tests__/infrastructure/inventory.routes.test.ts` — SCEN-LOC-3 (403), SCEN-MOV-8 (page=0→400), SCEN-MOV-9 (limit=101→400), SCEN-MOV-10 (type=INVALID→400), SCEN-ALT-4 (403); happy paths for all 3 routes with InMemory wiring
- [x] 5.4 [GREEN] Confirm all route tests pass; update `inventory-composition-root.test.ts` to assert the 3 new use cases are wired into `createInventoryRouter`

## Phase 6 — World A Retirement BE (surgical, no drops)

- [x] 6.1 Delete 12 World A use case files: `src/application/use-cases/{Create,Get,Update,Delete,List}InventoryItem.ts`, `{List,Update,Delete}InventoryProduct.ts`, `{Create,Update,Delete,List}InventoryUnit.ts`
- [x] 6.2 Remove 14 `Inventory*` methods from `src/domain/ports/EmpresaRepository.ts`; remove `InventoryItem/Product/Unit` types from `src/domain/entities/empresa.ts`
- [x] 6.3 Remove `Inventory*` method impls from `src/infrastructure/adapters/prisma/PrismaEmpresaRepository.ts`
- [x] 6.4 Remove `/inventory*` routes + their factory args from `src/infrastructure/http/routes/empresa.routes.ts`
- [x] 6.5 In `src/infrastructure/http/app.ts`: remove 12 World A `new ...`, remove World A imports, trim trailing World A args from `createEmpresaRouter` call
- [x] 6.6 Update `src/__tests__/infrastructure/empresa.routes.test.ts` — strip 15 World A test cases; verify remaining empresa tests still pass
- [x] 6.7 Update/delete `src/__tests__/infrastructure/inventoryUnits.routes.test.ts` + `src/__tests__/application/EmpresaUseCases.test.ts` + `src/__tests__/application/InventoryProductsUseCases.test.ts` — remove World A cases entirely

## Phase 7 — FE: Dashboard + Retirement

- [x] 7.1 Add `getOverview`, `getMovements(params)`, `getAlerts` to `src/api/inventory.api.ts` (new World B fns; World A fns removed)
- [x] 7.2 Create `src/hooks/useInventoryDashboard.ts` with `useInventoryOverview`, `useInventoryMovements(filters, page)`, `useInventoryAlerts` hooks
- [x] 7.3 Rewrite `src/pages/inventory/InventoryDashboardPage.tsx`: 3 tabs (`mountMode='lazy'`), `activeTab` state
  - **Ubicaciones tab**: `useInventoryOverview`; one section per type (header: type + counts); CLIENTE type collapses to single summary row ("N clientes con stock" + totalAssets + totalMaterialQty — no 53 cards); depot empty → "El depósito no tiene stock cargado"; other empty types → muted "Sin stock" line
  - **Movimientos tab**: `useInventoryMovements`; filter bar (type select, date range pickers, materialCatalogId/locationId/taskId inputs); results table (occurredAt, type badge, material/asset, qty, from→to labels, task, source); `Pagination` component; empty → "Sin movimientos para estos filtros"
  - **Alertas tab**: label carries badge `Alertas (N)` driven by `useInventoryAlerts` count; deficit table; empty → "Sin alertas de stock bajo" + hint
- [x] 7.4 Add `minStock` number input (default 0, min 0) to materials ABM modal + "Stock mín." column in materials table; thread through `useMaterialTypes` mutations + `src/types/materialType.ts`
- [x] 7.5 [RED] Write `src/__tests__/inventory/InventoryDashboardPage.test.tsx` — SCEN-FE-1 (renders 2 locations, labels), SCEN-FE-2 (empty state Ubicaciones), SCEN-FE-3 (Alertas badge=2), SCEN-FE-4 (403 redirect); SCEN-WA-1 (World A routes ≠ rendered); summary row for CLIENTE tested explicitly
- [x] 7.6 [GREEN] Confirm vitest dashboard tests pass; fix any typing issues
- [x] 7.7 Delete World A FE pages + css: `Inventory{Legacy,Items,Products,Supply}Page.tsx` (+ `.css` if co-located)
- [x] 7.8 Delete World A FE tests: `Inventory{Items,Products,Supply,Legacy}Page.test.tsx`
- [x] 7.9 Deleted `src/hooks/useInventory.ts` (World A fns) + rewrote `src/api/inventory.api.ts` (World A fns removed) — `src/types/inventory.ts` retained (no longer imported by live code)
- [x] 7.10 Update `src/App.tsx` — removed `list/items/products/supply` lazy imports + route entries (World A routes gone)
- [x] 7.11 Update `src/components/organisms/Sidebar/Sidebar.tsx` — removed Artículos/Productos/Suministro; retained Dashboard, Devoluciones, Descuentos pendientes, Camionetas, Configuración

## Phase 8 — Verify (SCEN-WA-2 + Full Suite)

- [x] 8.1 Run `npx jest --runInBand`; assert all tests green — SCEN-WA-2: no regression in scheduling, iClass, RBAC suites; no World A test file references remain — **2904 passed, 0 failed**
- [x] 8.2 Run `npx tsc --noEmit` on BE; zero errors after EmpresaRepository trim and World A deletion — **exit 0**
- [x] 8.3 Run `npx vitest run` on FE; confirm SCEN-FE-* + SCEN-WA-1 pass; zero TypeScript errors via FE tsc — **2108 passed, 0 failed**
- [x] 8.4 Verify migration parity: `prisma/schema.prisma` reflects `minStock` + `@@index`; migration SQL matches exactly (IF NOT EXISTS guards, no drops)

## Fix Wave (post-review — adversarial review findings)

- [x] FIX-1 [RED] Add SCEN-DATE-1/2 (bare YYYY-MM-DD accepted, same-day range), SCEN-DATE-3/4 (garbage→400) to `inventory.routes.test.ts`
- [x] FIX-1 [GREEN] `MovementsQuery` in `inventory.routes.ts`: accept bare `YYYY-MM-DD` via `.refine()`+`.transform()`, normalize dateFrom→`T00:00:00.000Z` dateTo→`T23:59:59.999Z`
- [x] FIX-2 Fix `@@index([type, occurredAt(sort: Desc)])` in `schema.prisma` to match migration SQL `("type","occurredAt" DESC)`; run `npx prisma generate`
- [x] FIX-3 [RED] Add FIX-3 test to `ListInventoryMovements.test.ts` — empty location still resolves label via `findLabelsByIds`
- [x] FIX-3 [GREEN] Add `findLabelsByIds(ids)` to `StockLocationRepository` port + `InMemoryStockLocationRepository` (seedLabel seam) + `PrismaStockLocationRepository` (ONE Prisma pass); `ListInventoryMovements` uses `findLabelsByIds` instead of `listWithContent`
- [x] FIX-4 [RED] Add FIX-4 test to `GetInventoryOverview.test.ts` — CLIENTE with only installed assets appears in overview
- [x] FIX-4 [GREEN] Remove `where: { status: 'available' }` from `PrismaStockLocationRepository.listWithContent()` asset groupBy — count ALL assets regardless of status
- [x] FIX-5a [RED] Add FIX-5a test to `materialTypeCatalog.routes.test.ts` — stub UpdateMaterial throws InvalidMinStockError → route returns 400
- [x] FIX-5a [GREEN] Add `InvalidMinStockError` catch in `PUT /material-types/:id` handler in `materialTypeCatalog.routes.ts` → 400
- [x] FIX-5b Delete orphan `src/types/inventory.ts` from FE (World A remnant, nothing imports it)
- [x] FIX-5c Update `spec.md`: date params named `dateFrom`/`dateTo`; materials route is `PUT /api/inventory/material-types/:id`; note bare date normalization; add `findLabelsByIds` to ports table; add post-review fix table
