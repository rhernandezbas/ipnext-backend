# Inventory Dashboard Specification

## Purpose

Read-only operator dashboard over World B inventory: a global location overview, a filterable movement ledger, global low-stock alerts, and the retirement of World A dead code. Covers Wave 7 (capstone) of EPIC #38.

---

## Requirements

### Requirement: Location Overview Endpoint

The system MUST expose `GET /api/inventory/overview/locations` (permission `inventory.read`) returning all `StockLocation` rows that have at least one asset OR at least one `MaterialStock` row with `qty > 0`. Empty locations MUST be excluded. Each item MUST carry resolved labels: `DEPOSITO → 'Depósito'`, `CLIENTE → client name + contract`, `TECNICO → RbacUser display name`, `CAMIONETA → vehicle plate`. Asset counts MUST be broken down by status. The query MUST be a single aggregation (no per-location N+1 in the port contract).

#### Scenario: SCEN-LOC-1 — mixed locations returned with correct labels

- GIVEN a DEPOSITO location with 3 assets (2 available, 1 in_use), 1 CLIENTE location with 0 assets but 5 qty of material M1, and 1 TECNICO location with no content
- WHEN `GET /api/inventory/overview/locations` is called with `inventory.read`
- THEN 200; response contains 2 entries (DEPOSITO + CLIENTE); TECNICO is excluded; DEPOSITO label is `'Depósito'`; CLIENTE label includes client/contract name; asset counts by status are present

#### Scenario: SCEN-LOC-2 — no locations with content → empty list 200

- GIVEN no StockLocation has any asset or material with qty > 0
- WHEN `GET /api/inventory/overview/locations` is called
- THEN 200 with `{ locations: [] }`

#### Scenario: SCEN-LOC-3 — 403 without inventory.read

- GIVEN user lacks `inventory.read`
- WHEN `GET /api/inventory/overview/locations` is called
- THEN 403 is returned

---

### Requirement: Movement Ledger Endpoint

The system MUST expose `GET /api/inventory/movements` (permission `inventory.read`) with offset pagination (`page` default 1, `limit` default 25, max 100). Filters `type`, `locationId`, `materialCatalogId`, `taskId`, `dateFrom`, `dateTo` MUST be combinable. Results MUST be ordered `occurredAt DESC`. Each item MUST be enriched with material name, asset serial, from/to location labels (same label resolution as overview), and task sequence number. Date params `dateFrom`/`dateTo` accept both full ISO datetime (`YYYY-MM-DDTHH:MM:SS.sssZ`) and bare `YYYY-MM-DD`; bare dates are normalized server-side (`dateFrom → T00:00:00.000Z`, `dateTo → T23:59:59.999Z`). Invalid strings return 400.

#### Scenario: SCEN-MOV-1 — pagination defaults

- GIVEN 30 movements exist
- WHEN `GET /api/inventory/movements` (no params) is called with `inventory.read`
- THEN 200; `items` has 25 entries; `page: 1`, `limit: 25`, `total: 30`; items ordered `occurredAt DESC`

#### Scenario: SCEN-MOV-2 — page 2

- GIVEN 30 movements exist
- WHEN `GET /api/inventory/movements?page=2&limit=25` is called
- THEN 200; `items` has 5 entries (remaining); `page: 2`

#### Scenario: SCEN-MOV-3 — filter by type

- GIVEN movements of types INSTALL (3) and RETURN (2) exist
- WHEN `GET /api/inventory/movements?type=INSTALL` is called
- THEN 200; all items have `type: 'INSTALL'`; count is 3

#### Scenario: SCEN-MOV-4 — filter by locationId

- GIVEN movements with `fromLocationId = L1` (2) and others exist
- WHEN `GET /api/inventory/movements?locationId=L1` is called
- THEN 200; only movements involving L1 (from or to) are returned

#### Scenario: SCEN-MOV-5 — filter by date range

- GIVEN movements on 2026-05-01 (2), 2026-06-01 (3), 2026-07-01 (1)
- WHEN `GET /api/inventory/movements?dateFrom=2026-06-01&dateTo=2026-06-30` is called
- THEN 200; 3 items returned; all within range

#### Scenario: SCEN-MOV-6 — combined filters

- GIVEN 5 INSTALL movements, 2 on locationId L1, 1 matching both
- WHEN `GET /api/inventory/movements?type=INSTALL&locationId=L1` is called
- THEN 200; only the 1 movement matching both filters is returned

#### Scenario: SCEN-MOV-7 — no results → empty list 200

- GIVEN no movements match the applied filters
- WHEN filtered request is made
- THEN 200 with `{ items: [], total: 0, page: 1, limit: 25 }`

#### Scenario: SCEN-MOV-8 — invalid page < 1 → 400

- GIVEN no precondition
- WHEN `GET /api/inventory/movements?page=0` is called
- THEN 400 is returned

#### Scenario: SCEN-MOV-9 — limit > 100 → 400

- GIVEN no precondition
- WHEN `GET /api/inventory/movements?limit=101` is called
- THEN 400 is returned

#### Scenario: SCEN-MOV-10 — invalid type → 400

- GIVEN no precondition
- WHEN `GET /api/inventory/movements?type=INVALID` is called
- THEN 400 is returned

---

### Requirement: MinStock on MaterialCatalog

The system MUST add an additive column `minStock Int @default(0)` to `MaterialCatalog`. The existing Materials ABM endpoint (`PUT /api/inventory/material-types/:id`) MUST accept `minStock` (integer ≥ 0). A negative value MUST return 400. A `minStock` of 0 means "no alert threshold configured."

#### Scenario: SCEN-MS-1 — update minStock via ABM PUT

- GIVEN material `M1` exists with `minStock: 0`
- WHEN `PUT /api/inventory/material-types/M1 { minStock: 10 }` is called with `inventory.manage`
- THEN 200; `M1.minStock` is 10; subsequent GET reflects updated value

#### Scenario: SCEN-MS-2 — negative minStock → 400

- GIVEN material `M1` exists
- WHEN `PUT /api/inventory/material-types/M1 { minStock: -1 }` is called
- THEN 400 is returned; `M1.minStock` is unchanged

---

### Requirement: Low-Stock Alerts Endpoint

The system MUST expose `GET /api/inventory/alerts` (permission `inventory.read`) returning materials where `SUM(MaterialStock.qty)` across all locations < `minStock` AND `minStock > 0`. Materials with `minStock = 0` MUST NOT appear. Each alert item MUST include `materialName`, `unit`, `minStock`, `totalQty`, `deficit` (`minStock - totalQty`).

#### Scenario: SCEN-ALT-1 — material below threshold appears

- GIVEN material `M1` has `minStock: 10` and total stock qty = 3
- WHEN `GET /api/inventory/alerts` is called with `inventory.read`
- THEN 200; response includes `M1` with `deficit: 7`

#### Scenario: SCEN-ALT-2 — material at or above threshold excluded

- GIVEN material `M1` has `minStock: 10` and total qty = 10; material `M2` has `minStock: 5` and total qty = 8
- WHEN `GET /api/inventory/alerts` is called
- THEN 200; neither `M1` nor `M2` appears in alerts

#### Scenario: SCEN-ALT-3 — minStock = 0 never alerts

- GIVEN material `M1` has `minStock: 0` and total qty = 0
- WHEN `GET /api/inventory/alerts` is called
- THEN 200; `M1` does NOT appear in the response

#### Scenario: SCEN-ALT-4 — 403 without inventory.read

- GIVEN user lacks `inventory.read`
- WHEN `GET /api/inventory/alerts` is called
- THEN 403 is returned

---

### Requirement: Dashboard FE — Tabbed Page

The system MUST render `/admin/inventory/dashboard` (gate `inventory.read`) as a single page with 3 tabs: **Ubicaciones**, **Movimientos**, **Alertas**. The Alertas tab MUST display a badge with the count of active alerts. The Ubicaciones tab MUST show a graceful empty state when no location has content (contextual label: "Sin stock en depósito hoy"). The Movimientos tab MUST include filter controls and the existing `Pagination` component. The `minStock` field MUST be editable in the Materials ABM form (gate `inventory.manage`).

#### Scenario: SCEN-FE-1 — Ubicaciones tab with content renders location cards

- GIVEN the overview endpoint returns 2 locations (DEPOSITO + 1 CLIENTE)
- WHEN the dashboard is loaded on the Ubicaciones tab
- THEN both locations render with resolved label, asset count by status, and material quantities

#### Scenario: SCEN-FE-2 — Ubicaciones tab empty state

- GIVEN the overview endpoint returns `{ locations: [] }`
- WHEN the Ubicaciones tab is active
- THEN an empty state message is shown; no error is thrown

#### Scenario: SCEN-FE-3 — Alertas tab badge shows count

- GIVEN 2 materials are below minStock threshold
- WHEN the dashboard page loads
- THEN the Alertas tab label shows a badge with `2`

#### Scenario: SCEN-FE-4 — 403 redirect for users without inventory.read

- GIVEN user lacks `inventory.read`
- WHEN navigating to `/admin/inventory/dashboard`
- THEN user is redirected or shown 403; dashboard content is not rendered

---

### Requirement: World A Retirement

The system MUST remove World A FE pages (`InventoryItemsPage`, `InventoryProductsPage`, `InventoryLegacyPage`, `InventorySupplyPage`) and their routes from `App.tsx`. The sidebar MUST remove entries: Artículos, Productos, Suministro; and retain: Dashboard, Devoluciones, Descuentos pendientes, Camionetas, Configuración. World A BE use cases (12 files) and World A methods on `EmpresaRepository` MUST be removed. World A routes MUST be de-registered. World A database TABLES MUST be dropped via migration. The remaining app (ServicePlan, NetworkDevice, scheduling, iClass) MUST be unaffected.

#### Scenario: SCEN-WA-1 — World A routes return 404 after cleanup

- GIVEN World A routes have been removed
- WHEN `GET /api/inventory/items`, `GET /api/inventory/products`, `GET /api/inventory/units` are called
- THEN 404 is returned for each

#### Scenario: SCEN-WA-2 — test suite passes after cleanup

- GIVEN World A use cases, routes, and FE pages have been removed
- WHEN the full test suite runs
- THEN all tests pass; no regression in scheduling, iClass, or RBAC suites

---

## Domain Model (New Fields)

| Entity | New Field |
|--------|-----------|
| `MaterialCatalog` | `minStock Int @default(0)` |
| `InventoryMovement` | + `@@index([type, occurredAt])` (composite) |

## Ports (New Methods)

| Port | New Method | Contract |
|------|------------|---------|
| `StockLocationRepository` | `listWithContent()` | Single aggregation; returns `StockLocationSummary[]` |
| `StockLocationRepository` | `findLabelsByIds(ids)` | Batch-resolve labels for ANY location ids (including empty) — FIX-3 |
| `InventoryMovementRepository` | `listMovements(filters, pagination)` | Returns page + total |
| `MaterialCatalogRepository` | `listLowStock()` | Returns `LowStockAlertDTO[]` where SUM(qty) < minStock AND minStock > 0 |

## Routes (New)

| Method | Path | Permission | Success | Errors |
|--------|------|-----------|---------|--------|
| GET | `/api/inventory/overview/locations` | `inventory.read` | 200 | 403 |
| GET | `/api/inventory/movements` | `inventory.read` | 200 | 400, 403 |
| GET | `/api/inventory/alerts` | `inventory.read` | 200 | 403 |
| PUT | `/api/inventory/material-types/:id` | `inventory.manage` | 200 | 400 (INVALID_MIN_STOCK), 404, 409 |

## Post-Review Fixes (Wave 7 Adversarial Review)

| Fix | What | Where |
|-----|------|-------|
| FIX-1 | `dateFrom`/`dateTo` accept bare `YYYY-MM-DD` (normalized server-side to UTC boundaries) | `inventory.routes.ts` MovementsQuery |
| FIX-2 | `@@index([type, occurredAt(sort: Desc)])` matches migration SQL | `schema.prisma` InventoryMovement |
| FIX-3 | `findLabelsByIds()` port + adapters — ledger labels resolve for empty locations | `StockLocationRepository` port + adapters |
| FIX-4 | `listWithContent()` counts ALL assets (no `status:'available'` filter) | `PrismaStockLocationRepository` |
| FIX-5a | `InvalidMinStockError` caught in `PUT /material-types/:id` → 400 | `materialTypeCatalog.routes.ts` |
| FIX-5b | Deleted orphan `src/types/inventory.ts` from FE (World A remnant) | FE types directory |
