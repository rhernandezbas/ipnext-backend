## Exploration: inventory-depot-stock (EPIC #38, Wave 3)

### Current State

#### Domain / Ports (Wave 1 foundation — all exist)

| Port | File | Status |
|------|------|--------|
| `InventoryAssetRepository` | `src/domain/ports/InventoryAssetRepository.ts` | EXISTS — no `listByLocation` |
| `MaterialStockRepository` | `src/domain/ports/MaterialStockRepository.ts` | EXISTS — no `listByLocation` |
| `StockLocationRepository` | `src/domain/ports/StockLocationRepository.ts` | EXISTS — has `findByCode(code)` |
| `MaterialCatalogRepository` | `src/domain/ports/MaterialCatalogRepository.ts` | EXISTS — has `list()` + `getById()` |
| `DeviceTypeCatalogRepository` | `src/domain/ports/DeviceTypeCatalogRepository.ts` | EXISTS — has `list()` + `getById()` |

**Key gap**: `InventoryAssetRepository` has only `findById`, `findBySerialNumber`, `create`, `updateLocation`, `updateStatus`. There is NO `listByLocation(locationId)` or `listByStatus(status)`. This is the primary missing port method.

**Key gap**: `MaterialStockRepository` has `findByMaterialAndLocation`, `upsert`, `decrement`, `increment`. There is NO `listByLocation(locationId)`. Missing.

#### Use Case: ResolveDepotLocation (Wave 1 — EXISTS, USABLE)
`src/application/use-cases/ResolveDepotLocation.ts` — idempotent find-or-create for `DEPOSITO` singleton by `code='DEPOSITO'`. Handles P2002 race. Returns `StockLocation` with `.id`. This use case is directly usable as a dependency in the new Wave 3 use case.

#### Prisma Adapters (Wave 1 — all exist)
- `PrismaInventoryAssetRepository` — no `listByLocation`, needs extension
- `PrismaMaterialStockRepository` — no `listByLocation`, needs extension
- `InMemoryInventoryAssetRepository` — no `listByLocation`, needs extension
- `InMemoryMaterialStockRepository` — needs checking (same gap expected)

#### HTTP Routes (what exists vs what's needed)
The `contractInventory.routes.ts` handles:
- `GET /api/contracts/:contractId/inventory` — contract-scoped installed items
- `GET /api/clients/:clientId/equipment` — client-scoped aggregate (Wave 2)
- Task-scoped suggestions + material consumption

**No depot endpoint exists.** There is no `GET /api/inventory/depot` or similar. This is new territory.

#### Production Data Reality
All 56 `InventoryAsset` rows are at CLIENTE locations (status `installed`). DEPOSITO has 0 assets. 0 `MaterialStock` rows exist (materials seeded later). The depot view will be empty until Wave 4 returns assets + material seeding. The FE MUST handle empty gracefully with a meaningful message.

---

### The FE Inventory Pages — World A Scaffolding Assessment

| Route | Page | Hook / API | What it renders | Real data? |
|-------|------|-----------|-----------------|-----------|
| `/admin/inventory/dashboard` | `InventoryDashboardPage` | `useInventoryItems()` → `api.getInventoryItems` | KPI cards + alert table over deprecated `InventoryItem` type | NO — World A only |
| `/admin/inventory/items` | `InventoryItemsPage` | `useInventoryItems()` | Table of deprecated `InventoryItem` | NO — World A only |
| `/admin/inventory/products` | `InventoryProductsPage` | `useInventoryProducts()` | Table of deprecated `InventoryProduct` | NO — World A only |
| `/admin/inventory/supply` | `InventorySupplyPage` | `useSupplyOrders()` | Supply orders table | NO — World A only |
| `/admin/inventory/list` | `InventoryLegacyPage` | `useInventoryProducts()` + `useInventoryUnits()` + mutations | Tabbed productos/ítems CRUD over deprecated model | NO — World A CRUD |
| `/admin/inventory/settings` | `InventorySettingsPage` | via `DeviceTypesBody` + `MaterialsBody` | Device types catalog + Materials catalog | YES — real data, live |

The hooks file (`useInventory.ts`) calls `api.getInventoryItems`, `api.getInventoryProducts`, etc. — all pointing at the old `InventoryItem/Product/Unit` API endpoints, not at the new Wave 1 domain model. There is no `api/inventory.api.ts` file in the FE — this strongly implies those stubs return mock/empty data or 404.

The `InventorySettingsPage` is the ONLY page using real data (device types + material catalog via dedicated hooks/endpoints). All other pages are dead scaffolding over the old Splynx-mirrored model.

---

### Approaches

#### Approach 1: Repurpose `InventoryItemsPage` as Depot Page
Point the existing `/admin/inventory/items` route at a rewritten page that calls the new `GET /api/inventory/depot` endpoint instead of the old `useInventoryItems` hook.

- Pros: Reuses the route, keeps nav structure unchanged, no new route entry needed
- Cons: Route name "items" is semantically misleading for depot stock; the old page had `InventoryItem` columns (name/category/quantity/etc) which are very different from the new `InventoryAsset` shape (serialNumber/mac/deviceType/status); refactor touches the hook+type in ways that could break other consumers; the old `InventoryItemsPage` references deprecated `InventoryItem` type throughout
- Effort: Medium (refactor existing page)

#### Approach 2: Build a NEW Depot Page alongside existing pages — recommended
Create `InventoryDepotPage.tsx` at `/admin/inventory/depot`, a new `useDepotStock` hook, and add it to the router. The old pages remain as dead scaffolding and can be cleaned up later or in a separate "World A cleanup" ticket.

- Pros: Zero risk of breaking existing scaffolding; clean type-safe DTO design from scratch; follows the Wave 2 pattern (new `ListClientEquipment` use case + new hook `useClientEquipment` + new tab in CustomerDetailPage); semantically correct URL; easy to ship and later delete the legacy pages in one batch
- Cons: One more route entry; legacy pages remain dormant (negligible — they already return empty/mock data)
- Effort: Low — the pattern is already established by Wave 2

#### Approach 3: Replace Dashboard + Items with a two-section Depot Dashboard
Repurpose `InventoryDashboardPage` to show real depot data (assets section + materials section), connected to the new endpoint.

- Pros: The dashboard URL is the most natural landing for a "what's in the depot" overview; kills two World-A pages in one move
- Cons: The dashboard currently has KPI logic over `InventoryItem` — the overlap is messy; a mixed KPI+table page needs more design; the empty state concern is amplified on a "dashboard" (empty + no KPIs = confusing)
- Effort: Medium

**Recommended: Approach 2.** Build a dedicated `InventoryDepotPage` at `/admin/inventory/depot`. This is exactly the pattern used in Wave 2 (`GET /api/clients/:clientId/equipment` → new `ListClientEquipment` use case → new `useClientEquipment` hook → new tab in `CustomerDetailPage`). The empty state concern is fully addressed by designing the new page to show clear contextual messaging when both lists are empty ("El depósito está vacío — los equipos aparecerán aquí cuando sean devueltos desde una instalación").

---

### Affected Areas

**BE — ipnext-backend**

- `src/domain/ports/InventoryAssetRepository.ts` — add `listByLocation(locationId: string): Promise<InventoryAsset[]>`
- `src/domain/ports/MaterialStockRepository.ts` — add `listByLocation(locationId: string): Promise<MaterialStock[]>`
- `src/infrastructure/adapters/prisma/PrismaInventoryAssetRepository.ts` — implement new method
- `src/infrastructure/adapters/prisma/PrismaMaterialStockRepository.ts` — implement new method
- `src/infrastructure/adapters/in-memory/InMemoryInventoryAssetRepository.ts` — implement new method
- `src/infrastructure/adapters/in-memory/InMemoryMaterialStockRepository.ts` — implement new method
- `src/application/use-cases/GetDepotStock.ts` — NEW use case (see below)
- `src/infrastructure/http/routes/contractInventory.routes.ts` OR new `inventory.routes.ts` — add `GET /api/inventory/depot`
- `src/infrastructure/http/app.ts` — wire new use case + route

**FE — ipnext-frontend**

- `src/api/depot.api.ts` (or extend `inventory.api.ts`) — `getDepotStock()`
- `src/hooks/useDepotStock.ts` — new React Query hook
- `src/types/depot.ts` (or extend `types/inventory.ts`) — `DepotAssetDTO`, `DepotMaterialDTO`, `DepotStockDTO`
- `src/pages/inventory/InventoryDepotPage.tsx` — NEW page
- `src/App.tsx` — add route `/admin/inventory/depot`

---

### DTOs + Endpoint Design

#### Endpoint
`GET /api/inventory/depot` — permission: `inventory.read`

#### Response shape
```typescript
interface DepotAssetDTO {
  id: string;
  serialNumber: string;
  mac: string | null;
  deviceTypeId: string;
  deviceTypeName: string;    // joined from DeviceTypeCatalog
  deviceTypeLabel: string | null;
  status: 'available';       // only available assets shown
}

interface DepotMaterialDTO {
  id: string;                // materialStock.id
  materialCatalogId: string;
  name: string;              // from MaterialCatalog
  label: string | null;
  unit: string | null;
  qty: number;
}

interface DepotStockDTO {
  assets: DepotAssetDTO[];
  materials: DepotMaterialDTO[];
  depotLocationId: string;   // for debug/future reference
}
```

#### Use Case: GetDepotStock
```typescript
// src/application/use-cases/GetDepotStock.ts
class GetDepotStock {
  constructor(
    private readonly locations: StockLocationRepository,
    private readonly assets: InventoryAssetRepository,
    private readonly materialStock: MaterialStockRepository,
    private readonly materialCatalog: MaterialCatalogRepository,
    private readonly deviceTypes: DeviceTypeCatalogRepository,
  ) {}

  async execute(): Promise<DepotStockDTO> {
    // 1. Resolve depot (idempotent — creates if missing)
    const depot = await new ResolveDepotLocation(this.locations).execute();
    // 2. Assets at depot with status=available
    const assets = await this.assets.listByLocation(depot.id);
    const availableAssets = assets.filter(a => a.status === 'available');
    // 3. Material stock at depot
    const stocks = await this.materialStock.listByLocation(depot.id);
    // 4. Enrich with catalog names (parallel)
    const [deviceTypeMap, catalogMap] = await Promise.all([
      this.deviceTypes.list().then(ts => new Map(ts.map(t => [t.id, t]))),
      this.materialCatalog.list().then(cs => new Map(cs.map(c => [c.id, c]))),
    ]);
    // ... map to DTOs
  }
}
```

**Alternative**: embed `ResolveDepotLocation` dependency directly (not inline `new`) — pass `StockLocationRepository` and call `findByCode('DEPOSITO')` directly. If null, return empty depot (no find-or-create on a read path). This is preferable — a GET should not create rows. `ResolveDepotLocation` is a write-capable use case; a clean read path should use `findByCode` and return empty if not bootstrapped.

**Recommended read path**: `findByCode('DEPOSITO')` → if null, return `{ assets: [], materials: [], depotLocationId: null }`. The depot is only created lazily when the first W1/W4 write hits it.

---

### What's Missing (Gap Summary)

| Gap | Effort |
|-----|--------|
| `InventoryAssetRepository.listByLocation(locationId)` port + prisma + in-memory | Small |
| `MaterialStockRepository.listByLocation(locationId)` port + prisma + in-memory | Small |
| `GetDepotStock` use case | Small |
| `GET /api/inventory/depot` route | Small |
| Wire in `app.ts` | Small |
| `DepotStockDTO` types | Trivial |
| FE: `useDepotStock` hook + `api/depot.api.ts` | Small |
| FE: `InventoryDepotPage` with two-section layout + empty state | Medium |
| FE: Route `/admin/inventory/depot` in `App.tsx` | Trivial |

---

### MaterialCatalog Confirmation

`MaterialCatalogRepository.list()` returns all `MaterialCatalog[]`. Each has: `id`, `name` (canonical UPPERCASE), `label` (display name), `unit`, `active`, `sortOrder`. The depot materials view joins `MaterialStock.materialCatalogId → MaterialCatalog` for display. Currently 0 `MaterialStock` rows exist, but the 7 catalog entries exist (seeded). The `DepotMaterialDTO` should include `qty: 0` rows only if those stocks exist — since the endpoint uses `listByLocation`, it returns only stock rows that exist at the depot, so qty=0 rows would only appear if they were explicitly created (they won't be until W4 or manual seeding). The FE materials section will be empty until then.

---

### Recommendation

**Wave 3 Scope** (BE + FE, read-only, low risk):

**BE:**
1. Add `listByLocation(locationId: string): Promise<InventoryAsset[]>` to `InventoryAssetRepository` port + Prisma + InMemory adapters
2. Add `listByLocation(locationId: string): Promise<MaterialStock[]>` to `MaterialStockRepository` port + Prisma + InMemory adapters
3. New use case `GetDepotStock` — calls `findByCode('DEPOSITO')` (no write), joins device types + catalog, returns `DepotStockDTO`
4. New route `GET /api/inventory/depot` in `contractInventory.routes.ts` (or a new `inventory.routes.ts`) — guard: `inventory.read`
5. Wire in `app.ts`

**FE:**
6. New `DepotAssetDTO`, `DepotMaterialDTO`, `DepotStockDTO` types
7. New `getDepotStock()` API function + `useDepotStock` hook
8. New `InventoryDepotPage` at `/admin/inventory/depot` — two sections: "Equipos en depósito" + "Stock de materiales" — each with a table or empty-state card
9. Add route in `App.tsx`

**FE Empty State Design**: since the depot will be empty until W4 + seeding, the page MUST show a clear, contextual empty state per section. Not a generic "no data". Something like: "Todavía no hay equipos en el depósito. Aparecerán aquí cuando sean retornados desde una instalación." and "El catálogo de materiales no tiene stock en el depósito. Se actualizará cuando se registre el ingreso de materiales."

**What NOT to include in Wave 3**: no write operations (no receive/adjust stock), no QR scanning, no pagination server-side (client-side is fine for the small result sets expected), no filtering beyond what the UI naturally handles.

---

### Risks

- **Empty depot until W4**: The FE will show an empty state for the entire Wave 3 lifecycle in prod. Teams might think it's broken. Mitigate with clear empty-state messaging and a "why is this empty?" tooltip or help text.
- **Port extension tests**: Adding `listByLocation` to both ports requires updating all `InMemory*` adapters and any existing tests that construct those adapters — but since the new methods are additive, existing tests don't break; only new tests need to be written.
- **No existing `GET /api/inventory/*` base route**: The depot endpoint is the first `inventory`-namespace route without a `:contractId` or `:clientId` scoping. Recommend mounting under `contractInventory.routes.ts` or creating a minimal `inventory.routes.ts` file. App.ts already has the pattern to follow.
- **DeviceType join on read**: The `GetDepotStock` use case needs both `DeviceTypeCatalogRepository` and `MaterialCatalogRepository`. This is a 5-dependency constructor — acceptable, follows the project's established pattern (ConfirmInventorySuggestion has 11 dependencies).
- **FE: `api/inventory.api.ts` doesn't exist** (no file found at `src/api/inventory.api.ts` via glob). The hooks import from `@/api/inventory.api` but no such file exists in the searched results — likely the file exists but is a stub returning mock data or 404s. The new depot API function should be in a separate `api/depot.api.ts` to avoid touching whatever broken state that file is in.

---

### Ready for Proposal

Yes. The scope is well-bounded, the read model is clear, the missing pieces are additive (no changes to existing behavior), and the FE pattern is established by Wave 2. Next step: `sdd-propose`.
