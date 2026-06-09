# Exploration: inventory-technician-stock (EPIC #38, Wave 5)

## Current State

### W1 foundation (shipped — all confirmed by code)

**`StockLocation`** (`prisma/schema.prisma` line 864, domain entity `src/domain/entities/stock-location.ts`):
- Type union: `'DEPOSITO' | 'CLIENTE' | 'TECNICO'` — CAMIONETA is NOT in the domain type yet (comment says "CAMIONETA is W5").
- `technicianId → RbacUser` FK exists at the schema level (line 871) and in the domain factory: `createStockLocation({ type: 'TECNICO', technicianId })` validates presence.
- Port (`StockLocationRepository`) has `findByTypeAndTechnician(type, technicianId)` — fully implemented in both in-memory and Prisma adapters.
- Schema uniqueness: `@@unique([type, technicianId])` — one TECNICO location per technician, enforced at DB level.

**`ResolveTechnicianLocation` — DOES NOT EXIST.**
- Only `ResolveDepotLocation` (`src/application/use-cases/ResolveDepotLocation.ts`) and `ResolveClientLocation` (`src/application/use-cases/ResolveClientLocation.ts`) were shipped in W1/W2.
- Pattern is clear: find-or-create with P2002-race guard. `ResolveTechnicianLocation` is a mechanical copy of `ResolveClientLocation` swapping `contractId` for `technicianId` and type `'CLIENTE'` for `'TECNICO'`.

**Movement ledger** (`src/domain/entities/inventory-movement.ts`):
- `MovementType` = `'ISSUE' | 'TRANSFER' | 'INSTALL' | 'RETURN' | 'CONSUME' | 'ADJUST'`.
- **CRITICAL SEMANTIC**: `ISSUE` = material-only, decrement-from-source, NO toLocation increment. It is a write-off/consumption verb. To MOVE stock to a technician, the correct verb is **`TRANSFER`** (from=DEPOSITO, to=TECNICO/CAMIONETA location).
- **`TRANSFER` for assets**: `computeAssetEffect` (`src/domain/entities/inventory-asset-effect.ts` line 36) handles TRANSFER → `{ currentLocationId: toLocationId }`. Asset moves to the technician's location.
- **`TRANSFER` for materials**: `PrismaInventoryMovementRepository.applyMaterialEffect` case 'TRANSFER' (line 203) → atomicDecrement from `fromLocationId` + increment at `toLocationId`. Full DEPOSITO→TECNICO balance move in one atomic write.
- `RecordInventoryMovement` (`src/application/use-cases/RecordInventoryMovement.ts`) is the ONLY mutation entry point. W5 reuses it directly — no new write primitive needed.

**Stock view** (`src/application/use-cases/GetDepotStock.ts`):
- Calls `assets.listByLocation(locationId)` (generic port, W3) + `materialStock.listByLocation(locationId)`.
- `GetTechnicianStock` / `GetVehicleStock` = mechanical clones of this use case, keyed by `technicianId` / `vehicleId` instead of the DEPOSITO code.
- `InventoryAssetRepository.listByLocation` is already generic (returns ALL assets regardless of status — comment in port: "Generic on purpose (W7 dashboard reuse) — status filtering lives in the use case").

### Vehicle/Truck gap

**No Vehicle/truck model exists anywhere in the codebase** — confirmed via glob (`src/**/*ehicle*`, `src/**/*ruck*` → 0 results). CAMIONETA was explicitly deferred (schema comment: "CAMIONETA is W5").

### FE inventory pages (existing)

Mounted at `/inventory/*`:
- `depot` — `InventoryDepotPage` (W3, read-only DEPOSITO view).
- `returns` — `InventoryReturnsPendingPage` (W4).
- No technician/fleet/vehicle page exists. No technician detail page in `src/pages/scheduling/` either.

---

## Affected Areas

**BE — new files:**
- `src/application/use-cases/ResolveTechnicianLocation.ts` — find-or-create TECNICO StockLocation per technicianId.
- `src/application/use-cases/IssueStockToTechnician.ts` — operator-driven TRANSFER: resolves technician location, calls `RecordInventoryMovement(TRANSFER)` for each item. Name uses "issue" in the business sense ("issued to field"), not the ISSUE movement type.
- `src/application/use-cases/GetTechnicianStock.ts` — mirrors GetDepotStock, keyed by technicianId.
- `src/application/dto/TechnicianStockDto.ts` — mirrors DepotStockDto with `technicianLocationId` + `technicianId` fields.
- `src/infrastructure/http/routes/inventory.routes.ts` — add `POST /technicians/:technicianId/issue` and `GET /technicians/:technicianId/stock`.
- `src/__tests__/application/ResolveTechnicianLocation.test.ts`
- `src/__tests__/application/IssueStockToTechnician.test.ts`
- `src/__tests__/application/GetTechnicianStock.test.ts`

**FE — new files:**
- `src/pages/inventory/InventoryTechnicianPage.tsx` + CSS module — per-technician stock view (mirrors InventoryDepotPage, prefilled by technicianId from URL param).
- `src/api/inventory.ts` — new hooks/calls for the two new endpoints.
- Route: `/inventory/technicians/:id` wired in `App.tsx`.

**BE — schema changes (CAMIONETA, if in-scope for W5):**
- `prisma/schema.prisma`: new `Vehicle` model + extend `StockLocationType` to include `'CAMIONETA'` + add `vehicleId → Vehicle` FK on `StockLocation`.
- Migration file.
- `src/domain/entities/stock-location.ts`: add `'CAMIONETA'` to `StockLocationType`, `vehicleId` field, factory guard.
- `src/application/use-cases/ResolveVehicleLocation.ts` — find-or-create CAMIONETA location per vehicleId.
- `src/application/use-cases/GetVehicleStock.ts`.
- New CRUD for Vehicle (out of W5 scope unless ops need it).

---

## Approaches

### 1. TECNICO-only W5 (recommended: defer CAMIONETA)
Issue stock to technicians via their existing TECNICO StockLocation (W1 already modeled). CAMIONETA deferred to W5b or W6.

- Pros: No schema migration needed. Domain type + FK + port method + adapter all exist. Pure application-layer work: 3 use cases + 1 DTO + 2 routes + FE page. Low DB risk. Can ship fast.
- Cons: Doesn't cover the "por camioneta" use case. If a technician drives multiple trucks, TECNICO conflates the technician and the vehicle.
- Effort: Medium (1–2 days BE + 1 day FE).

### 2. TECNICO + CAMIONETA in one W5
Add the Vehicle model + CAMIONETA StockLocation type alongside the technician flow.

- Pros: Complete W5 as originally scoped. Operators can track "what's in the truck" independently of the technician (useful when one truck serves multiple technicians, or a vehicle is reassigned).
- Cons: Schema migration needed. New `Vehicle` CRUD (plates, name) before locations can be resolved. Domain type enum expansion. More surface area = more tests.
- Effort: High (3–4 days BE + 1.5 days FE).

### 3. CAMIONETA as a TECNICO alias (no Vehicle model)
Treat truck stock as technician stock (existing TECNICO location). Annotate the location with a `label`/`name` field (e.g. "Camioneta patente ABC123").

- Pros: Zero schema migration. Domain unchanged. Quick.
- Cons: No way to distinguish "stock on person" from "stock on vehicle." If a technician swaps trucks, you lose traceability. Doesn't model reality.
- Effort: Low (not recommended for a real ISP operation).

---

## Recommendation

**Ship W5 in two steps:**

**W5a — TECNICO stock management (this change):**
Implement the full issue-to-technician + view-technician-stock flow using the TECNICO location already modeled in W1. This is pure application-layer work with no schema migrations. Deliver:
1. `ResolveTechnicianLocation` use case.
2. `IssueStockToTechnician` use case — operator-driven (ops selects technician + items from DEPOSITO → TRANSFER moves them).
3. `GetTechnicianStock(technicianId)` use case + `GET /inventory/technicians/:id/stock` endpoint.
4. `POST /inventory/technicians/:id/issue` endpoint (body: `{ items: [{ type:'asset'|'material', id, qty? }] }`).
5. FE: `InventoryTechnicianPage` at `/inventory/technicians/:id`.

**W5b — CAMIONETA (separate change):**
Add the `Vehicle` model (plate, name, assignedTechnicianId?), extend `StockLocationType` to `'CAMIONETA'`, add `vehicleId` FK on `StockLocation`, `ResolveVehicleLocation`, `GetVehicleStock`, vehicle CRUD. Requires a migration.

**Issue/transfer is operator-driven** — an ops user selects "assign 5 connectors + 1 ONU to técnico X" from a form. NOT automatic. The movement records `technicianId` on the ledger row for auditability.

**Minimal `Vehicle` model shape (for W5b):**
```prisma
model Vehicle {
  id                   String         @id @default(uuid())
  plate                String         @unique   // patente
  name                 String?                  // alias (e.g. "Camioneta Sur")
  assignedTechnicianId String?
  assignedTechnician   RbacUser?      @relation(fields: [assignedTechnicianId], references: [id], onDelete: SetNull)
  status               String         @default("active") // active | inactive
  createdAt            DateTime       @default(now())
  updatedAt            DateTime       @updatedAt
  stockLocations       StockLocation[]
}
```
`StockLocation` gains `vehicleId String?` + `@@unique([type, vehicleId])`.

---

## Risks

- **TRANSFER semantic vs ISSUE naming confusion**: the movement type for moving stock to a technician is `TRANSFER`, not `ISSUE` (ISSUE is material-only write-off). The use case name `IssueStockToTechnician` uses "issue" in the business/ops sense ("issued to field"), but internally calls `RecordInventoryMovement({ type: 'TRANSFER' })`. This must be documented clearly to avoid future confusion.
- **Asset status after TRANSFER to TECNICO**: `computeAssetEffect` on TRANSFER only updates `currentLocationId`, NOT `status`. An asset transferred to a technician remains `'available'` (not yet `'installed'`). This is correct — the asset is "in the field, assigned to a tech" but not yet installed at a client. Consider whether a new status like `'assigned'` is needed, or whether `'available'` is acceptable for W5. If `'available'` stays, the depot GET filters `status === 'available'` and would still show assets transferred to a technician (they'd appear in BOTH depot and technician views). The depot GET filters by `locationId` (depot's own), so this is NOT a double-show issue — but the status label may confuse ops. **Recommendation**: leave status unchanged for W5a; add `'assigned'` in W5b if needed.
- **Schema migration for CAMIONETA**: extending `StockLocationType` from a TypeScript union to include 'CAMIONETA' is safe (additive); the `StockLocation.type` column is `String` not a Postgres enum, so no Postgres migration gymnastics needed. But adding the `vehicleId` FK and the `Vehicle` table requires a migration.
- **FE technician selector**: the issue form needs a list of active technicians (RbacUsers with role `technician`). This requires a `GET /users?role=technician` endpoint — check if it exists or needs to be added.
- **No `RbacUser` list endpoint verified**: not explicitly checked in this exploration. Verify before spec.

---

## Ready for Proposal

Yes. The W5a scope (TECNICO-only) is fully unblocked: all BE primitives exist (domain type, FK, port method, movement ledger, `listByLocation`). The three missing use cases are mechanical derivations of existing ones. Risk is LOW-MEDIUM (pure application layer, no schema migrations, reuses the W1 atomic UoW).

W5b (CAMIONETA/Vehicle) should be a separate change entry — it requires a schema migration and new CRUD.
