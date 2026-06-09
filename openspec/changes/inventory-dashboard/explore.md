# Exploration: inventory-dashboard (EPIC #38, Wave 7 — Capstone)

**Date**: 2026-06-09  
**Branch**: feat/38-w7-inventory-dashboard (BE) / feat/38-w7-inventory-dashboard-ui (FE)  
**Artifact store**: hybrid

---

## Current State

### BE — What exists

#### Stock read endpoints (`GET /api/inventory/*`)
Three parallel use cases — `GetDepotStock`, `GetTechnicianStock`, `GetVehicleStock` — all clones of the same pattern:
1. Resolve `StockLocation` (findByCode / findByTypeAndX)
2. `listByLocation(locationId)` on `InventoryAssetRepository` → filter `status === 'available'` in use case
3. `listByLocation(locationId)` on `MaterialStockRepository` (all quantities)
4. Enrich with `DeviceTypeCatalog` and `MaterialCatalog` names (per-item `getById` — potential N+1 if many types, but in practice there are ≤ 7 device types so it's bounded)
5. Return DTO

**Shared signatures**:
- `InventoryAssetRepository.listByLocation(locationId: string): Promise<InventoryAsset[]>` — generic, status-agnostic
- `MaterialStockRepository.listByLocation(locationId: string): Promise<MaterialStock[]>` — generic

**No `listAll` locations query exists** in `StockLocationRepository`. The port only has: `findByCode`, `findByTypeAndContract`, `findByTypeAndTechnician`, `findByTypeAndVehicle`, `create`. A "global view across all locations with content" requires a new port method: `listWithContent(): Promise<StockLocationSummary[]>` — or a Prisma query that joins StockLocation with its assets/materials counts.

The N+1 on the global view is the key risk: for 53 CLIENTE locations + 1 DEPOSITO = 54 locations, doing 54 × (listByLocation assets + listByLocation materials) = 108 queries is acceptable for now given the small scale, but a dedicated aggregation query is cleaner.

#### InventoryMovement Ledger
Schema (`prisma/schema.prisma:992`):
- Columns: `id`, `type` (ISSUE|TRANSFER|INSTALL|RETURN|CONSUME|ADJUST), `assetId?`, `materialCatalogId?`, `qty?`, `fromLocationId?`, `toLocationId?`, `taskId?`, `technicianId?`, `source`, `note`, `occurredAt`, `createdAt`, `sourceRef?`
- Existing indexes: `@@index([assetId, type])`, `@@index([materialCatalogId])`, `@@index([taskId])`, `@@index([occurredAt])`
- **No composite index** combining type + occurredAt, or fromLocationId/toLocationId + occurredAt

Port (`InventoryMovementRepository`): only has `record()`, `listByAsset()`, `findBySourceRef()`. **No `list` / `query` method exists** — must be added.

Prod scale: ~57 movements. At this scale, offset pagination is fine. Keyset pagination (like the activity log) is premature unless we expect high write volume. Decision: offset pagination (page/limit) with server-side filters for the ledger query.

#### minStock
`minStock` exists on the DEPRECATED `InventoryItem` (schema:1413) and `InventoryProduct` (schema:1430) models only — the World A models. It does **NOT exist** on `MaterialCatalog` (schema:544) or `MaterialStock` (schema:976). Confirmed: `MaterialCatalog` has `name`, `label`, `unit`, `active`, `sortOrder` — no `minStock`.

**Migration required**: additive column `minStock Int @default(0)` on `MaterialCatalog`. The alert query is then: `SELECT mc.id, mc.name, mc.label, mc.unit, mc.minStock, SUM(ms.qty) AS totalQty FROM MaterialCatalog mc JOIN MaterialStock ms ON ms.materialCatalogId = mc.id GROUP BY mc.id HAVING SUM(ms.qty) < mc.minStock AND mc.minStock > 0`.

#### MaterialCatalogRepository
Port: `list()`, `getById()`, `getByName()`, `create()`, `update()`, `delete()`, `countInUse()`, `listActiveNames()`. **No `listWithAlerts()` or aggregation query**. Must add: `listLowStock(): Promise<LowStockAlertDTO[]>` or handle it as a new use case that joins via Prisma.

#### World A Legacy (BE)
The `ListInventoryItems`, `ListInventoryProducts`, `ListInventoryUnits`, `CreateInventoryItem`, `DeleteInventoryItem`, etc. use cases all depend on `EmpresaRepository` — the same port that serves `ServicePlan`, `NetworkDevice` etc. They are bundled inside the fat `EmpresaRepository` interface. Blast radius of removing them:
- `src/application/use-cases/ListInventoryItems.ts`, `CreateInventoryItems.ts`, `UpdateInventoryItem.ts`, `DeleteInventoryItem.ts`, `GetInventoryItem.ts` (5 files)
- `src/application/use-cases/ListInventoryProducts.ts`, `UpdateInventoryProduct.ts`, `DeleteInventoryProduct.ts` (3 files)  
- `src/application/use-cases/ListInventoryUnits.ts`, `CreateInventoryUnit.ts`, `UpdateInventoryUnit.ts`, `DeleteInventoryUnit.ts` (4 files)
- `src/domain/ports/EmpresaRepository.ts` — must remove the InventoryItem/Product/Unit methods (service plans / network devices stay)
- `src/domain/entities/empresa.ts` — must remove `InventoryItem`, `InventoryProduct`, `InventoryUnit` entity types
- Routes: no dedicated `inventory-legacy.routes.ts` exists; these are registered somewhere inside `app.ts`
- `prisma/schema.prisma`: `InventoryItem`, `InventoryProduct`, `InventoryUnit` models are `@deprecated` but still present — removing them requires a migration with `DROP TABLE`
- FE: `inventory.api.ts`, `useInventory.ts`, `InventoryDashboardPage.tsx`, `InventoryItemsPage.tsx`, `InventoryProductsPage.tsx`, `InventoryLegacyPage.tsx`, `InventorySupplyPage.tsx`

The `SupplyOrders` endpoint (`/inventory/supply-orders`) also appears to be a World A ghost — `useSupplyOrders()` hits that endpoint with 0 live writers.

**Risk assessment**: Medium. The EmpresaRepository entanglement means the deletion must be surgical. The World A tables have 0 rows in prod. The FE pages import from `useInventory` which also has non-World-A stuff? No — `useInventory.ts` is purely World A. Safe to delete the whole file.

### FE — What exists

#### Inventory pages currently registered in App.tsx (routes):
| Route | Component | Status |
|-------|-----------|--------|
| `/admin/inventory/list` | `InventoryLegacyPage` | World A — delete |
| `/admin/inventory/dashboard` | `InventoryDashboardPage` | World A shell — REPLACE with new |
| `/admin/inventory/items` | `InventoryItemsPage` | World A — delete |
| `/admin/inventory/products` | `InventoryProductsPage` | World A — delete |
| `/admin/inventory/supply` | `InventorySupplyPage` | World A — delete |
| `/admin/inventory/depot` | `InventoryDepotPage` | Live (W3) — keep |
| `/admin/inventory/technicians/:id` | `InventoryTechnicianPage` | Live (W5a) — keep |
| `/admin/inventory/vehicles/:id` | `InventoryVehiclePage` | Live (W5b) — keep |
| `/admin/inventory/returns` | `InventoryReturnsPendingPage` | Live (W4) — keep |
| `/admin/inventory/deductions` | `InventoryDeductionsPendingPage` | Live (W6) — keep |
| `/admin/inventory/settings` | `InventorySettingsPage` | Live (W5a/b) — keep |

#### Sidebar (current):
Dashboard, Artículos, Productos, Suministro, Devoluciones, Descuentos pendientes, Camionetas (→settings#camionetas), Configuración.

World A sidebar items to remove: Artículos, Productos, Suministro.  
New items to add: Ledger (Movimientos), Alertas (or inline in Dashboard).

#### Existing FE dashboard pattern (`InventoryDashboardPage.tsx`):
Already has a KPI-card + DataTable structure but sources from the deprecated `useInventoryItems()` → World A API. The file needs to be completely rewritten pointing to new W7 endpoints.

#### Tabs component already exists:
`src/pages/inventory/InventorySettingsPage.tsx` uses `@/components/molecules/Tabs/Tabs` — this can be reused for the dashboard tabs (by-location + ledger + alerts as tabs or sections).

---

## Affected Areas

### Backend
- `src/domain/ports/InventoryMovementRepository.ts` — add `listMovements(filters, pagination)` method
- `src/domain/ports/MaterialCatalogRepository.ts` — add `listLowStock()` method  
- `src/domain/ports/StockLocationRepository.ts` — add `listWithContent()` or `listAll()` for global view
- `src/domain/ports/MaterialStockRepository.ts` — add `listAll()` or aggregation needed for alert query
- `src/application/use-cases/GetInventoryDashboard.ts` — NEW: global location summary (all locations with content)
- `src/application/use-cases/ListInventoryMovements.ts` — NEW: paginatable, filterable ledger read
- `src/application/use-cases/GetStockAlerts.ts` — NEW: materials with qty < minStock
- `src/application/dto/InventoryDashboardDto.ts` — NEW
- `src/application/dto/InventoryMovementDto.ts` — NEW (for list view)
- `src/infrastructure/adapters/prisma/PrismaInventoryMovementRepository.ts` — add `listMovements`
- `src/infrastructure/adapters/prisma/PrismaStockLocationRepository.ts` — add `listWithContent`
- `src/infrastructure/adapters/prisma/PrismaMaterialCatalogRepository.ts` — add `listLowStock`
- `src/infrastructure/http/routes/inventory.routes.ts` — add `GET /movements`, `GET /dashboard`, `GET /alerts`
- `prisma/schema.prisma` — add `minStock Int @default(0)` to `MaterialCatalog`
- **World A cleanup** (if in scope for W7):
  - `src/application/use-cases/CreateInventoryItem.ts`, `DeleteInventoryItem.ts`, `GetInventoryItem.ts`, `ListInventoryItems.ts`, `UpdateInventoryItem.ts`
  - `src/application/use-cases/DeleteInventoryProduct.ts`, `ListInventoryProducts.ts`, `UpdateInventoryProduct.ts`
  - `src/application/use-cases/CreateInventoryUnit.ts`, `DeleteInventoryUnit.ts`, `ListInventoryUnits.ts`, `UpdateInventoryUnit.ts`
  - `src/domain/ports/EmpresaRepository.ts` (partial — remove inventory methods)
  - Routes that wire World A use cases (need to find where in app.ts)

### Frontend
- `src/pages/inventory/InventoryDashboardPage.tsx` — FULL REWRITE
- `src/pages/inventory/InventoryDashboardPage.module.css` — likely rewrite
- `src/api/inventory.api.ts` — replace World A methods with new dashboard/movements/alerts fetchers
- `src/hooks/useInventory.ts` — replace with new hooks
- `src/components/organisms/Sidebar/Sidebar.tsx` — update inventory nav items
- `src/App.tsx` — remove World A routes, keep live routes
- **World A FE pages to delete** (if in scope):
  - `InventoryItemsPage.tsx`, `InventoryItemsPage.module.css`
  - `InventoryProductsPage.tsx`
  - `InventoryLegacyPage.tsx`, `InventoryLegacyPage.module.css`
  - `InventorySupplyPage.tsx`

---

## Approaches

### Approach A: Single-page dashboard with tabs
One route `/admin/inventory/dashboard` → one page with 3 tabs: **Por ubicación** | **Movimientos** | **Alertas**

- Pros: single nav entry, user never leaves "Inventario", standard pattern in this codebase (Settings page does this)
- Cons: slightly more FE complexity (tab state + lazy fetching per tab)
- Effort: Medium

### Approach B: Three separate pages
`/admin/inventory/dashboard`, `/admin/inventory/movements`, `/admin/inventory/alerts`

- Pros: simpler per-page, deep-linkable, faster initial load
- Cons: more sidebar entries, more routes
- Effort: Medium-High

### Approach C: Single scrollable page (no tabs)
All three sections stacked vertically

- Pros: simplest FE, no tab state
- Cons: ugly if the ledger table is long; alerts should be contextual, not buried below 100 movement rows
- Effort: Low

**Recommendation**: Approach A (tabs). The `Tabs` component already exists and is used in `InventorySettingsPage`. The by-location view is a summary panel (cards/small tables, no pagination needed at 54 locations). The ledger is a filterable table with client-side or server-side pagination. The alerts section is a short warning list. All fit naturally in tabs.

### minStock scope: global vs per-location

**Option 1 (Global per material)**: `minStock` on `MaterialCatalog` — alert fires when the SUM of all `MaterialStock.qty` across all locations < `minStock`. Simple migration, one column, no join complexity per location.

**Option 2 (Per depot/location)**: `minStock` on `MaterialStock` (the junction row). Alert fires per (material, location) pair. More nuanced (a material can be low at the depot but fine overall).

**Recommendation**: Option 1 (global per material on `MaterialCatalog`). Rationale: (1) field-service ISPs track "do I have enough of this material in total to keep operations going" — location-level granularity adds complexity with negligible benefit at 7 materials; (2) the ABM for materials is already in `MaterialsBody.tsx` (InventorySettingsPage tab) — adding one field there is trivial; (3) avoids schema complexity on `MaterialStock` which would need a composite unique per-location minStock.

### Ledger pagination: offset vs keyset

**Option 1 (Offset/page)**: `?page=1&limit=50&type=INSTALL&from=2026-01-01&to=2026-06-30`
- Simple, predictable, works fine at ≤ 1000 rows
- Matches how `InventoryItemsPage` and `InventoryProductsPage` paginate (client-side with Pagination component)

**Option 2 (Keyset cursor, like activity log)**: `?limit=50&cursor=<base64>`
- Better for very large tables, stable under concurrent inserts
- Overkill at ~57 rows; hides useful "jump to page 3" UX

**Recommendation**: Offset pagination (`?page&limit&filters`). The dataset is small (57 rows now, maybe 5000 in a year). The existing `Pagination` FE component is already built for this. If the dataset grows > 10k, a cursor can be added later.

### World A cleanup: W7 or separate?

**Blast radius measured**:
- BE: 12 use-case files + partial EmpresaRepository port + routes + Prisma models (migrations)
- FE: 4 page files + 4 CSS modules + 1 API file + 1 hooks file (partially shared with nothing live)
- Risk: EmpresaRepository hosts both World A inventory AND ServicePlan/NetworkDevice — surgical deletion needed; the inventory-specific DB tables need a DROP migration

**Decision factors**:
- W7 is already the capstone (closes EPIC #38) — including the cleanup keeps the epic self-contained
- The blast radius is well-understood and isolated (no live readers of World A inventory in prod)
- The 4 FE pages + 3 sidebar items will confuse operators if left alive while the new dashboard exists
- BUT: adding schema migrations (DROP TABLE) to a read-only dashboard wave increases review risk

**Recommendation**: Include World A cleanup in W7 but isolate it as a **separate task block** from dashboard work. Implement dashboard first (low risk), then cleanup (medium risk, isolated). The cleanup is a mechanical deletion with a destructive migration — it should be its own PR step or at minimum a clear task group.

---

## Recommendation

**W7 scope** (closed):
1. `minStock` migration on `MaterialCatalog` + extend MaterialsBody ABM form
2. `GET /api/inventory/dashboard` — global location summary (counts by type, DEPOSITO detail)
3. `GET /api/inventory/movements` — paginatable ledger (offset, filters: type, locationId, technicianId, materialCatalogId, dateFrom, dateTo, taskId)
4. `GET /api/inventory/alerts` — materials where totalQty < minStock (and minStock > 0)
5. FE: rewrite `InventoryDashboardPage` as tabbed (Ubicaciones | Movimientos | Alertas)
6. FE + BE: World A cleanup (destructive, isolated task group, last step)

**Sidebar after W7**: Dashboard, Devoluciones, Descuentos pendientes, Configuración (World A items removed).  
The Depósito/Técnico/Camioneta stock views are accessible FROM the dashboard (drill-down links), not top-level sidebar entries — they already have their own routes for direct access.

---

## Risks

- **N+1 on global location view**: For 54 locations, doing `listByLocation` per location = 108 queries (assets + materials). Mitigation: use a single Prisma query with `include` (JOIN) on the locations + their stocks/assets count, not iterating. Add `listWithContent()` to the port that returns aggregated counts in one query.
- **minStock migration**: Additive, non-breaking (`@default(0)` means all existing materials start at 0 = no false alerts). Low risk.
- **World A DROP TABLE migration**: Tables are empty in prod but migration is irreversible. Mitigation: run `SELECT COUNT(*)` on all three tables in prod before applying. Include in release notes.
- **EmpresaRepository surgery**: Removing inventory methods from the interface breaks the Prisma adapter. Must update `PrismaEmpresaRepository` (or equivalent) and any tests. Bounded risk.
- **`InventoryMovementRepository.listMovements` index**: The current schema has `@@index([occurredAt])` which covers date-range queries. Adding `type` filter without a composite index is acceptable at ≤ 1000 rows (seq scan is faster than index at small scale). For the propose: add `@@index([type, occurredAt])` explicitly.
- **FE empty states**: With 0 TECNICO and 0 CAMIONETA stock in prod, the "Por ubicación" tab will show many empty location cards. Design must handle this gracefully (show type headers with "sin stock" label rather than hiding them entirely).

---

## Open Decisions for Propose

| Decision | Options | Leaning |
|----------|---------|---------|
| (a) World A cleanup in W7? | Yes (same wave, isolated task) vs No (separate wave) | **Yes, isolated task group** |
| (b) minStock global vs per-location | Global on MaterialCatalog vs per-row on MaterialStock | **Global on MaterialCatalog** |
| (c) Ledger pagination | Offset (page+limit) vs Keyset cursor | **Offset — simple, fits Pagination component** |
| (d) Dashboard structure | Single tabbed page vs 3 separate pages | **Single tabbed page (reuses Tabs component)** |
| (e) Global location view N+1 | Per-location iteration vs single aggregation query | **Single aggregation query in Prisma adapter** |

---

## File Map

### Backend (new / modified)
```
prisma/schema.prisma                                           — add minStock to MaterialCatalog
prisma/migrations/<timestamp>_w7_inventory_dashboard/          — new
src/domain/ports/InventoryMovementRepository.ts                — add listMovements()
src/domain/ports/MaterialCatalogRepository.ts                  — add listLowStock()
src/domain/ports/StockLocationRepository.ts                    — add listWithContent()
src/application/dto/InventoryDashboardDto.ts                   — NEW
src/application/dto/InventoryMovementListDto.ts                — NEW
src/application/dto/StockAlertDto.ts                           — NEW
src/application/use-cases/GetInventoryDashboard.ts             — NEW
src/application/use-cases/ListInventoryMovements.ts            — NEW
src/application/use-cases/GetStockAlerts.ts                    — NEW
src/infrastructure/adapters/prisma/PrismaInventoryMovementRepository.ts  — add listMovements
src/infrastructure/adapters/prisma/PrismaStockLocationRepository.ts      — add listWithContent
src/infrastructure/adapters/prisma/PrismaMaterialCatalogRepository.ts    — add listLowStock
src/infrastructure/adapters/in-memory/InMemoryInventoryMovementRepository.ts — add listMovements
src/infrastructure/adapters/in-memory/InMemoryStockLocationRepository.ts     — add listWithContent
src/infrastructure/adapters/in-memory/InMemoryMaterialCatalogRepository.ts   — add listLowStock
src/infrastructure/http/routes/inventory.routes.ts             — add 3 new GET routes
```

### Frontend (new / modified)
```
src/pages/inventory/InventoryDashboardPage.tsx                 — FULL REWRITE
src/pages/inventory/InventoryDashboardPage.module.css          — FULL REWRITE
src/pages/inventory/settings/MaterialsBody.tsx                 — add minStock field
src/api/inventory.api.ts                                       — add getDashboard, getMovements, getAlerts
src/hooks/useInventory.ts                                      — add useDashboard, useMovements, useAlerts
src/components/organisms/Sidebar/Sidebar.tsx                   — update inventory nav
src/App.tsx                                                    — remove World A routes (if cleanup in scope)
```

### World A cleanup (if in W7)
```
BE: 12 use-case files + EmpresaRepository methods + route wiring in app.ts
FE: InventoryItemsPage, InventoryProductsPage, InventoryLegacyPage, InventorySupplyPage + CSS + api + hooks
Migration: DROP TABLE "InventoryItem", "InventoryProduct", "InventoryUnit"
```

---

## Ready for Proposal

Yes. All decisions are clear or leaning strongly in one direction. The four open decisions (a–d) should be confirmed in the proposal, but the technical path is unambiguous either way.
