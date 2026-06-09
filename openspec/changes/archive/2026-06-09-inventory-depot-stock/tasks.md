# Tasks: Inventory Depot Stock (EPIC #38, Wave 3)

## Batch A — Backend

### Phase A1: Ports (Foundation)

- [x] A1.1 `src/domain/ports/InventoryAssetRepository.ts` — add `listByLocation(locationId: string): Promise<InventoryAsset[]>`
- [x] A1.2 `src/domain/ports/MaterialStockRepository.ts` — add `listByLocation(locationId: string): Promise<MaterialStock[]>`

### Phase A2: Adapters

> DESIGN ADJUSTMENT (orchestrator): `listByLocation` on assets is GENERIC — returns ALL assets at the location regardless of status. The `status='available'` filter lives in the use case (W7 dashboard reuse). Field is `currentLocationId` for assets, `locationId` for materials (tasks.md `stockLocationId` was wrong terminology).

- [x] A2.1 `PrismaInventoryAssetRepository.ts` — implement `listByLocation`: `WHERE currentLocationId=?` (NO status filter — generic)
- [x] A2.2 `PrismaMaterialStockRepository.ts` — implement `listByLocation`: `WHERE locationId=?`
- [x] A2.3 `InMemoryInventoryAssetRepository.ts` — implement `listByLocation`: filter by `currentLocationId` (all statuses)
- [x] A2.4 `InMemoryMaterialStockRepository.ts` — implement `listByLocation`: filter by `locationId`

### Phase A3: Use Case (TDD — RED first)

- [x] A3.1 RED `src/__tests__/application/GetDepotStock.test.ts` — write failing tests: depot-with-assets+materials returns enriched DTOs; no depot row returns `{assets:[],materials:[],depotLocationId:null}`; only-available assets filtered
- [x] A3.2 GREEN `src/application/use-cases/GetDepotStock.ts` — implement: `findByCode('DEPOSITO')` → null→empty; parallel `listByLocation`; parallel catalog enrichment; map to `DepotAssetDTO[]` + `DepotMaterialDTO[]`; return `DepotStockDTO` (DTOs in `src/application/dto/DepotStockDto.ts`)
- [x] A3.3 REFACTOR — catalog enrichment extracted into private `loadDeviceTypes`/`loadMaterials` map helpers; no Prisma import in the use case

### Phase A4: Route + Wiring (TDD — RED first)

- [x] A4.1 RED `src/__tests__/infrastructure/inventory.routes.test.ts` — write failing supertest tests: 200 with correct DTO shape; 403 without `inventory.read`; response is DTO (not raw Prisma entity)
- [x] A4.2 GREEN `src/infrastructure/http/routes/inventory.routes.ts` — new router; `GET /depot` → `auth` + `requirePerm('inventory','read')` → `GetDepotStock.execute()` → `res.json`
- [x] A4.3 `src/infrastructure/http/app.ts` — add `app.use('/api/inventory', createInventoryRouter(...))` with DI wiring (GetDepotStock 5 deps + auth + perm)
- [x] A4.4 VERIFY — `npx jest` all green (347 suites/2743 tests); `tsc --noEmit` clean

---

## Batch B — Frontend

### Phase B1: Types + API Layer (TDD — RED first)

- [x] B1.1 `src/types/depot.ts` — define `DepotAssetDTO`, `DepotMaterialDTO`, `DepotStockDTO` matching BE shapes
- [x] B1.2 `src/api/depot.api.ts` — `getDepotStock(): Promise<DepotStockDTO>` calling `GET /api/inventory/depot`; completely separate from `inventory.api.ts`

### Phase B2: Hook

- [x] B2.1 RED `src/hooks/__tests__/useDepotStock.test.tsx` — write failing tests with mocked `depot.api.ts`: loading state, populated data, error state
- [x] B2.2 GREEN `src/hooks/useDepotStock.ts` — React Query hook wrapping `getDepotStock()`; `staleTime: 30000`

### Phase B3: Page (TDD — RED first)

- [x] B3.1 RED `src/__tests__/pages/inventory/InventoryDepotPage.test.tsx` — write failing tests: renders "Equipos disponibles" section with assets; renders "Materiales" section with materials; contextual empty state for assets mentions W4 returns; contextual empty state for materials mentions stocking; permission gating (no render without `inventory.read`)
- [x] B3.2 GREEN `src/pages/inventory/InventoryDepotPage.tsx` — two sections (Equipos disponibles + Materiales); contextual empty states per section; consume `useDepotStock`; impeccable layout
- [x] B3.3 `src/App.tsx` — add route `/admin/inventory/depot` → `<InventoryDepotPage />` gated `inventory.read`

### Phase B4: Verify

- [x] B4.1 VERIFY — `npx vitest run` all green (244 files, 2025 passed | 1 todo); `npm run typecheck` clean; no `inventory.api.ts` import in B files
