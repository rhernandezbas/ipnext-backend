# Design: Inventory Dashboard (EPIC #38 Wave 7 — Capstone)

## Technical Approach

Hexagonal + additive + strict TDD. Three read-only use cases over the World B stack
(`GetInventoryOverview`, `ListInventoryMovements`, `GetLowStockAlerts`), each behind a
new port method with Prisma + InMemory parity. One additive migration
(`20260615000000_inventory_dashboard`): `MaterialCatalog.minStock` + composite movement
index. `minStock` editing folds into the existing Materials ABM (`materialTypeCatalog`).
World A retirement is an isolated, NO-DROP block: delete dead use cases/pages/routes,
trim only the World-A methods from the fat `EmpresaRepository`. FE: one tabbed page
replaces the World A `InventoryDashboardPage` shell at the same route.

**N+1 avoidance** is the central decision: the overview adapter does ONE Prisma pass
(groupBy + selective include for labels); the ledger does ONE `findMany` + ONE `count`,
then batch-resolves names by unique id (W6 `ListPendingDeductions` pattern). No per-row
or per-location queries anywhere.

## Architecture Decisions

| Decision | Choice | Rejected | Rationale |
|----------|--------|----------|-----------|
| minStock granularity | Global on `MaterialCatalog` | Per-row on `MaterialStock` | 7 materials; "do I have enough overall" is the operational question; trivial ABM add |
| Overview shape | `listWithContent()` returns 1 row/location with FK ids + assetCount + materialQty; **labels resolved in adapter via selective include** | Resolve labels in use case via repos | `ContractRepository` has NO `findById`; adapter already joins; InMemory mirrors by storing label fields on a test-only setter |
| Ledger pagination | Offset (`page`/`limit`, default 25) | Keyset cursor | ~57 rows; reuses `PaginatedResult<T>` + FE `Pagination`; "jump to page" UX |
| Ledger label enrichment | Use-case batch maps by unique id (material/location/technician/task) | Adapter join | Mirrors W6 `ListPendingDeductions`; keeps port returning plain `InventoryMovement[]` + total |
| Movement index | `@@index([type, occurredAt])` | none | Covers the `type` filter + `occurredAt DESC` order in one index |
| World A cleanup | Delete code + trim port; **NO DROP TABLE** | Drop legacy tables | Brief override of explore: deprecate-without-drop; additive-only migration; zero rollback risk |
| EmpresaRepository surgery | Remove only `Inventory*` methods (ServicePlan/NetworkDevice stay); grep proves no other importer | Leave dead | `useInventory.ts` + 5 pages are the ONLY consumers (grep-verified) |

## Data Flow

```
GET /api/inventory/overview/locations
  Router → GetInventoryOverview.execute()
    → StockLocationRepository.listWithContent()   // 1 Prisma pass: groupBy assets+stock, include contract.client/technician/vehicle for labels
    → returns InventoryOverviewDTO (groups by type, label+count+qty)

GET /api/inventory/movements?page&limit&type&locationId&materialCatalogId&taskId&technicianId&dateFrom&dateTo
  Router (Zod parse) → ListInventoryMovements.execute(filters,page,limit)
    → InventoryMovementRepository.listMovements(filters,page,limit) → { items, total }   // 1 findMany + 1 count
    → batch-resolve: materialMap, locationMap(label), userMap, taskMap  (unique ids)
    → InventoryMovementListDTO { items: MovementRowDTO[], total, page, limit }

GET /api/inventory/alerts
  Router → GetLowStockAlerts.execute()
    → MaterialCatalogRepository.listLowStock() → LowStockAlertDTO[]   // SUM(qty) per material vs minStock>0
```

## Interfaces / Contracts

### Ports (exact signatures)
```ts
// StockLocationRepository — add:
interface LocationContent {
  id: string; type: StockLocationType; code: string | null;
  contractId: string | null; technicianId: string | null; vehicleId: string | null;
  label: string | null;        // client name | technician name | vehicle plate | 'Depósito'
  assetCount: number;          // available assets at this location
  materialQty: number;         // SUM(MaterialStock.qty) at this location
}
listWithContent(): Promise<LocationContent[]>;

// InventoryMovementRepository — add:
interface MovementFilters {
  type?: MovementType; locationId?: string;      // matches from OR to
  materialCatalogId?: string; taskId?: string; technicianId?: string;
  dateFrom?: string; dateTo?: string;            // ISO; inclusive
}
listMovements(filters: MovementFilters, page: number, limit: number)
  : Promise<{ items: InventoryMovement[]; total: number }>;   // occurredAt DESC

// MaterialCatalogRepository — add (minStock added to entity + create/update data):
listLowStock(): Promise<LowStockAlertDTO[]>;     // only minStock>0 AND SUM(qty)<minStock
```

### DTOs (wire contract — FE builds against this)
```ts
// InventoryOverviewDto.ts
interface OverviewLocationDTO { locationId: string; label: string | null; assetCount: number; materialQty: number; }
interface OverviewGroupDTO { type: 'DEPOSITO'|'CLIENTE'|'TECNICO'|'CAMIONETA'; locationCount: number; totalAssets: number; totalMaterialQty: number; locations: OverviewLocationDTO[]; }
interface InventoryOverviewDTO { groups: OverviewGroupDTO[]; }   // ALL 4 types always present (empty → count 0)

// InventoryMovementListDto.ts
interface MovementRowDTO {
  id: string; type: MovementType; occurredAt: string;
  assetId: string | null; materialCatalogId: string | null; materialName: string | null;
  qty: number | null;
  fromLocationId: string | null; fromLocationLabel: string | null;
  toLocationId: string | null; toLocationLabel: string | null;
  taskId: string | null; taskSeq: number | null;
  technicianId: string | null; technicianName: string | null;
  source: string; note: string | null;
}
interface InventoryMovementListDTO { items: MovementRowDTO[]; total: number; page: number; limit: number; }

// StockAlertDto.ts
interface LowStockAlertDTO { materialCatalogId: string; name: string; label: string | null; unit: string | null; totalQty: number; minStock: number; deficit: number; }

// inventory.dto.ts — extend Create/UpdateMaterialSchema + MaterialCatalogDto with: minStock: z.number().int().min(0)  /  minStock: number
```

### Route wiring (inventory.routes.ts — new args appended LAST, W6 ordering rule)
```ts
// 3 GET, all auth+requireRead. Ledger query parsed by Zod:
const MovementsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  type: z.enum(['ISSUE','TRANSFER','INSTALL','RETURN','CONSUME','ADJUST']).optional(),
  locationId: z.string().min(1).optional(), materialCatalogId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(), technicianId: z.string().min(1).optional(),
  dateFrom: z.string().datetime().optional(), dateTo: z.string().datetime().optional(),
});
// getInventoryOverview?, listInventoryMovements?, getLowStockAlerts? appended after getVehicleStock/issueStockToVehicle;
// registered only when all three are provided (mirrors W6 optional-guard).
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `prisma/migrations/20260615000000_inventory_dashboard/migration.sql` | Create | `ADD COLUMN minStock` (IF NOT EXISTS, DEFAULT 0) + `CREATE INDEX IF NOT EXISTS InventoryMovement_type_occurredAt_idx`. NO drops |
| `prisma/schema.prisma` | Modify | `minStock Int @default(0)` on MaterialCatalog; `@@index([type, occurredAt])` on InventoryMovement |
| `src/domain/entities/material-catalog.ts` | Modify | add `minStock: number` |
| `src/domain/ports/{StockLocation,InventoryMovement,MaterialCatalog}Repository.ts` | Modify | new methods above |
| `src/application/dto/{InventoryOverviewDto,InventoryMovementListDto,StockAlertDto}.ts` | Create | wire DTOs |
| `src/application/dto/inventory.dto.ts` | Modify | minStock in schemas + MaterialCatalogDto |
| `src/application/use-cases/{GetInventoryOverview,ListInventoryMovements,GetLowStockAlerts}.ts` | Create | 3 read use cases |
| `src/application/use-cases/{CreateMaterial,UpdateMaterial}.ts` | Modify | pass-through minStock |
| `src/infrastructure/adapters/prisma/{PrismaStockLocation,PrismaInventoryMovement,PrismaMaterialCatalog}Repository.ts` | Modify | implement new methods (single-pass) |
| `src/infrastructure/adapters/in-memory/{InMemoryStockLocation,InMemoryInventoryMovement,InMemoryMaterialCatalog}Repository.ts` | Modify | parity impls |
| `src/infrastructure/http/routes/inventory.routes.ts` | Modify | 3 GET routes + Zod query |
| `src/infrastructure/http/routes/materialTypeCatalog.routes.ts` | (none) | minStock flows through existing PUT/POST via DTO |
| `src/infrastructure/http/app.ts` | Modify | wire 3 use cases into createInventoryRouter; **DELETE** World A wiring (see below) |

### World A retirement (surgical, NO DROP) — grep-verified blast radius
| File | Action |
|------|--------|
| BE use cases (12): `{Create,Get,Update,Delete,List}InventoryItem`, `{List,Update,Delete}InventoryProduct`, `{Create,Update,Delete,List}InventoryUnit` | Delete |
| `src/domain/ports/EmpresaRepository.ts` | Modify — remove 14 `Inventory*` methods (ServicePlan/NetworkDevice stay) |
| `src/domain/entities/empresa.ts` | Modify — remove `InventoryItem/Product/Unit` types |
| `src/infrastructure/adapters/prisma/PrismaEmpresaRepository.ts` | Modify — remove their impls |
| `src/infrastructure/http/routes/empresa.routes.ts` | Modify — remove `/inventory*` routes + their factory args |
| `src/infrastructure/http/app.ts` | Modify — remove 12 World A `new ...` (L802-813), imports (L253-264), and the trailing args of `createEmpresaRouter` (L1283-1285) |
| BE tests: `empresa.routes.test.ts`, `inventoryUnits.routes.test.ts`, `EmpresaUseCases.test.ts`, `InventoryProductsUseCases.test.ts` | Modify/Delete — strip World A cases (counts: 15/22/4/8 refs) |
| `prisma/schema.prisma` InventoryItem/Product/Unit models | **KEEP** (deprecated, no DROP) |
| FE pages: `Inventory{Legacy,Items,Products,Supply}Page.tsx` (+ css) | Delete |
| FE: `useInventory.ts`, `inventory.api.ts` (World A fns), `types/inventory.ts` (World A types) | Delete/trim — sole consumers are the 4 deleted pages (grep-verified) |
| FE tests: `Inventory{Items,Products,Supply,Legacy}Page.test.tsx` | Delete |
| FE `App.tsx` | Modify — remove `list/items/products/supply` routes + lazy imports (L63,131-133,277,279,280,286) |
| FE `Sidebar.tsx` | Modify — remove Artículos/Productos/Suministro (L148-150) → Dashboard, Devoluciones, Descuentos pendientes, Camionetas, Configuración |
| FE `InventoryDashboardPage.tsx` (+css) | **Rewrite** (not delete) — new tabbed page |

## FE Design (Impeccable)

- **`InventoryDashboardPage`**: `Tabs` molecule, 3 tabs, `mountMode='lazy'` (fetch per tab). State: `activeTab`.
  - **Ubicaciones** (`useInventoryOverview`): one card-section per type (DEPOSITO, CLIENTE, TECNICO, CAMIONETA) — header shows type label + `locationCount` + `totalAssets`/`totalMaterialQty`. Empty type → section still renders with a muted "Sin stock" line (0 TECNICO/CAMIONETA in prod = first impression). Depot empty → "El depósito no tiene stock cargado".
  - **Movimientos** (`useInventoryMovements`, filters in state): `FilterBar` (type select, date range, material/location/task) + table (occurredAt, type badge, material/asset, qty, from→to labels, task, source) + `Pagination` driven by `total/limit`. Empty → "Sin movimientos para estos filtros".
  - **Alertas** (`useInventoryAlerts`): tab label carries a count badge (`Alertas (N)`); table of deficit rows (material, totalQty, minStock, deficit). Empty → "Sin alertas de stock bajo" (positive empty state). When all minStock=0 → "Configurá un stock mínimo en los materiales para ver alertas".
- **Hooks** (`useInventory` is deleted; add to a fresh `useInventoryDashboard.ts`): `useInventoryOverview`, `useInventoryMovements(filters,page)`, `useInventoryAlerts`. New api fns in `inventory.api.ts`: `getOverview`, `getMovements(params)`, `getAlerts`.
- **MaterialsBody**: add `minStock` number input (default 0) to the modal + a "Stock mín." column in the table; thread through `useMaterialTypes` mutations + `types/materialType.ts`.

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Use case | Overview groups all 4 types incl. empty; labels resolved; no N+1 | InMemory repos; assert query/lookup call counts |
| Use case | Ledger filters (each + combined), offset paging, DESC order, batch enrichment | InMemory; seed mixed movements |
| Use case | Alerts: only minStock>0 AND SUM<minStock; deficit math; multi-location SUM | InMemory material+stock |
| Adapter parity | Prisma vs InMemory return identical shapes for all 3 new methods | Shared contract test |
| Route | 3 GETs: auth/perm, Zod 400 on bad query, happy path, empty states | supertest + InMemory wiring |
| Composition-root | `inventory-composition-root.test.ts`: assert app.ts wires the 3 new use cases into `createInventoryRouter` | Static regex (existing pattern) |
| Cleanup regression | Build/typecheck green after EmpresaRepository trim; remaining empresa tests pass | jest + tsc |

## Migration / Rollout

Single additive migration, idempotent (`IF NOT EXISTS`), parity-exact with schema. No
backfill (DEFAULT 0 = no false alerts). No DROP — World A tables persist. Rollback =
revert PR; leaving `minStock`/index is harmless.

## Open Questions

- [ ] CLIENTE label at 53 locations — render all cards or collapse to "53 clientes con stock" summary + count? (Lean: summary row + count; per-client detail via existing depot/technician drill-downs.) Decide in tasks/FE.
