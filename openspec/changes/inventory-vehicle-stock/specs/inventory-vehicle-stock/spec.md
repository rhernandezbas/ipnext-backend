# Inventory Vehicle Stock Specification

## Purpose

Extends the W1 inventory ledger with a Vehicle catalog (ABM) and a CAMIONETA stock location type. Operators manage a vehicle fleet and issue depot stock to individual trucks. Mirrors W5a (technician stock) semantics — no movement-semantics changes to the existing ledger.

## Requirements

### Requirement: Vehicle Catalog CRUD

The system MUST maintain a `Vehicle` entity with fields `id`, `plate` (unique), `name?`, `assignedTechnicianId?`, and `status: active|inactive`. `plate` MUST be provided on create; duplicate plate MUST return 409 `VEHICLE_PLATE_CONFLICT`. Delete MUST be guarded: if a CAMIONETA `StockLocation` or any stock references the vehicle, the system MUST reject with 409 `VEHICLE_IN_USE`. Status toggle is the safe "park a truck" operation.

#### Scenario: SCEN-VH-1 — create vehicle happy path

- GIVEN no vehicle with plate `ABC-123` exists
- WHEN `POST /api/vehicles { plate: 'ABC-123', name: 'Camioneta Norte' }` is called with `inventory.manage`
- THEN a vehicle is created with `status: active` and 201 is returned

#### Scenario: SCEN-VH-2 — duplicate plate → 409

- GIVEN a vehicle with plate `ABC-123` exists
- WHEN `POST /api/vehicles { plate: 'ABC-123' }` is called
- THEN 409 `VEHICLE_PLATE_CONFLICT` is returned; no vehicle is created

#### Scenario: SCEN-VH-3 — missing plate → 400

- GIVEN no precondition
- WHEN `POST /api/vehicles {}` is called (plate omitted)
- THEN 400 is returned

#### Scenario: SCEN-VH-4 — toggle status inactive/active

- GIVEN an active vehicle `V1`
- WHEN `PATCH /api/vehicles/V1 { status: 'inactive' }` is called with `inventory.manage`
- THEN vehicle `V1` has `status: inactive`

#### Scenario: SCEN-VH-5 — guarded delete: vehicle has CAMIONETA location → 409

- GIVEN vehicle `V1` has a CAMIONETA `StockLocation` or stock references
- WHEN `DELETE /api/vehicles/V1` is called with `inventory.manage`
- THEN 409 `VEHICLE_IN_USE` is returned; vehicle is NOT deleted

#### Scenario: SCEN-VH-6 — safe delete: no references

- GIVEN vehicle `V1` has no CAMIONETA location and no stock references
- WHEN `DELETE /api/vehicles/V1` is called with `inventory.manage`
- THEN 204 is returned; vehicle is removed

#### Scenario: SCEN-VH-7 — permission guard: list requires inventory.read

- GIVEN user lacks `inventory.read`
- WHEN `GET /api/vehicles` is called
- THEN 403 is returned

#### Scenario: SCEN-VH-8 — permission guard: create requires inventory.manage

- GIVEN user has `inventory.read` but lacks `inventory.manage`
- WHEN `POST /api/vehicles` is called
- THEN 403 is returned

---

### Requirement: CAMIONETA StockLocation

The system MUST extend `StockLocationType` with `'CAMIONETA'`. A CAMIONETA location MUST carry a non-null `vehicleId → Vehicle`. The factory MUST reject creating a CAMIONETA location without a vehicleId. `@@unique([type, vehicleId])` ensures at most one CAMIONETA per vehicle.

`ResolveVehicleLocation(vehicleId)` MUST return or create the CAMIONETA location for that vehicle (find-or-create idempotent). On P2002 race condition (concurrent create), it MUST retry once and return the existing row.

#### Scenario: SCEN-CL-1 — resolve creates CAMIONETA location for new vehicle

- GIVEN vehicle `V1` has no CAMIONETA location
- WHEN `ResolveVehicleLocation('V1')` is called
- THEN a new `StockLocation { type: 'CAMIONETA', vehicleId: 'V1' }` is created and returned

#### Scenario: SCEN-CL-2 — resolve is idempotent for existing location

- GIVEN a CAMIONETA location for `V1` already exists
- WHEN `ResolveVehicleLocation('V1')` is called
- THEN the same location id is returned; no duplicate is created

#### Scenario: SCEN-CL-3 — factory rejects CAMIONETA without vehicleId

- GIVEN no precondition
- WHEN `createStockLocation({ type: 'CAMIONETA', vehicleId: null })` is called
- THEN `MissingLocationFkError` is thrown

---

### Requirement: GetVehicleStock

The system MUST return a `VehicleStockDTO` with the vehicle's assets and material balances at its CAMIONETA location. If no CAMIONETA location exists yet (no stock ever issued), the system MUST return an empty DTO (assets: [], materials: []) — NOT 404. Assets MUST be enriched with `deviceType`; materials MUST be enriched with `materialCatalog` (mirrors `GetTechnicianStock`).

#### Scenario: SCEN-GS-1 — stock after issuance returns items

- GIVEN vehicle `V1` has a CAMIONETA location with one asset and one material balance
- WHEN `GET /api/inventory/vehicles/V1/stock` is called with `inventory.read`
- THEN response 200 contains `{ vehicleId: 'V1', assets: [...], materials: [...] }` with enriched fields

#### Scenario: SCEN-GS-2 — no location yet → empty DTO, not 404

- GIVEN vehicle `V1` exists but has no CAMIONETA location
- WHEN `GET /api/inventory/vehicles/V1/stock` is called
- THEN 200 with `{ vehicleId: 'V1', assets: [], materials: [] }` is returned

#### Scenario: SCEN-GS-3 — unknown vehicle → 404

- GIVEN no vehicle with id `X1` exists
- WHEN `GET /api/inventory/vehicles/X1/stock` is called
- THEN 404 is returned

---

### Requirement: IssueStockToVehicle

The system MUST support a multi-item TRANSFER from the DEPOSITO singleton to a vehicle's CAMIONETA location. All items MUST be processed inside a single `UnitOfWork` transaction. Guards (checked before the transaction):

- Vehicle MUST exist → else 404
- Vehicle MUST have `status: active` → else 422 `VEHICLE_INACTIVE`
- Each asset MUST be `status: available` AND `currentLocationId === depot.id` → else 409 `ASSET_NOT_AT_DEPOT`
- Each material MUST have sufficient qty at depot → else 409 `INSUFFICIENT_DEPOT_STOCK`

Requires permission `inventory.write`.

#### Scenario: SCEN-IS-1 — happy path: issues asset + material atomically

- GIVEN vehicle `V1` is active, depot has asset `A1` (available) and material `M1` qty=10
- WHEN `POST /api/inventory/vehicles/V1/issue { items: [{type:'asset',assetId:'A1'},{type:'material',materialCatalogId:'M1',qty:2}] }` with `inventory.write`
- THEN 200; asset `A1` currentLocationId = CAMIONETA(V1); material `M1` depot qty decremented by 2; CAMIONETA(V1) balance incremented by 2

#### Scenario: SCEN-IS-2 — vehicle not found → 404

- GIVEN no vehicle with id `X1` exists
- WHEN `POST /api/inventory/vehicles/X1/issue` is called
- THEN 404 is returned

#### Scenario: SCEN-IS-3 — inactive vehicle → 422

- GIVEN vehicle `V1` has `status: inactive`
- WHEN `POST /api/inventory/vehicles/V1/issue` is called
- THEN 422 `VEHICLE_INACTIVE` is returned; no transfer occurs

#### Scenario: SCEN-IS-4 — asset not at depot → 409

- GIVEN vehicle `V1` is active, asset `A1` is at a CLIENTE location (not depot)
- WHEN issue is called with `assetId: 'A1'`
- THEN 409 `ASSET_NOT_AT_DEPOT` is returned; transaction is rolled back

#### Scenario: SCEN-IS-5 — insufficient depot material stock → 409

- GIVEN depot has `M1` qty=1 and issue requests qty=5
- WHEN issue is called
- THEN 409 `INSUFFICIENT_DEPOT_STOCK` is returned; no movement recorded

#### Scenario: SCEN-IS-6 — permission guard: requires inventory.write

- GIVEN user has `inventory.read` but lacks `inventory.write`
- WHEN `POST /api/inventory/vehicles/V1/issue` is called
- THEN 403 is returned

---

### Requirement: Frontend — Vehicle Management Tab

The settings page MUST include a "Camionetas" tab (alongside "Equipos" and "Materiales") where operators with `inventory.manage` can create, edit, toggle status, and delete vehicles. Users lacking `inventory.manage` MUST see the tab as read-only (no mutation controls rendered).

#### Scenario: SCEN-FE-1 — Camionetas tab renders vehicle list

- GIVEN user has `inventory.manage` and vehicles exist
- WHEN the "Camionetas" tab is active in InventorySettingsPage
- THEN the vehicle list is rendered with plate, name, status, and action buttons

#### Scenario: SCEN-FE-2 — read-only user sees no mutation controls

- GIVEN user has `inventory.read` but not `inventory.manage`
- WHEN the "Camionetas" tab is active
- THEN no "Agregar", "Editar", or "Eliminar" controls are rendered

---

### Requirement: Frontend — Vehicle Stock Page and Navigation

The system MUST provide a vehicle stock page at `/admin/inventory/vehicles/:id` displaying the vehicle's assets and materials. A vehicles list page at `/admin/inventory/vehicles` MUST serve as the entry point. The sidebar MUST include a "Camionetas" entry under Inventario. An "Asignar stock" modal MUST allow operators with `inventory.write` to select items and issue them to the vehicle.

#### Scenario: SCEN-FE-3 — sidebar Camionetas entry navigates to list

- GIVEN user has `inventory.read`
- WHEN "Camionetas" sidebar entry is clicked
- THEN navigation goes to `/admin/inventory/vehicles`

#### Scenario: SCEN-FE-4 — vehicle stock page empty state

- GIVEN vehicle `V1` exists but has no stock
- WHEN `/admin/inventory/vehicles/V1` is rendered
- THEN an empty state message is displayed (no 404, no error)

#### Scenario: SCEN-FE-5 — assign stock modal gated by inventory.write

- GIVEN user lacks `inventory.write`
- WHEN the vehicle stock page is rendered
- THEN "Asignar stock" button is not visible or disabled

---

## Domain Model

| Entity | Key Fields |
|--------|-----------|
| `Vehicle` | `id`, `plate` (unique), `name?`, `assignedTechnicianId?`, `status: active\|inactive` |
| `StockLocation` (extended) | + `vehicleId?: string` · `type` union += `'CAMIONETA'` · `@@unique([type, vehicleId])` |
| `VehicleStockDTO` | `vehicleId`, `assets: EnrichedAsset[]`, `materials: EnrichedMaterialBalance[]` |

## Ports

| Port | New Methods |
|------|-------------|
| `VehicleRepository` | `findById`, `findByPlate`, `list`, `create`, `update`, `delete`, `countLocationRefs` |
| `StockLocationRepository` | + `findByTypeAndVehicle(type, vehicleId)` |

## Routes

| Method | Path | Permission | Success | Error codes |
|--------|------|-----------|---------|-------------|
| GET | `/api/vehicles` | `inventory.read` | 200 | 403 |
| POST | `/api/vehicles` | `inventory.manage` | 201 | 400, 403, 409 |
| PATCH | `/api/vehicles/:id` | `inventory.manage` | 200 | 403, 404 |
| DELETE | `/api/vehicles/:id` | `inventory.manage` | 204 | 403, 404, 409 |
| GET | `/api/inventory/vehicles/:id/stock` | `inventory.read` | 200 | 403, 404 |
| POST | `/api/inventory/vehicles/:id/issue` | `inventory.write` | 200 | 403, 404, 409, 422 |
