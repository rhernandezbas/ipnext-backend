# Proposal: Inventory — Technician Stock (W5a)

## Intent

Operators need to assign physical equipment and materials from the warehouse to field technicians, and track what each technician currently holds. W1 built the full ledger infrastructure (TRANSFER movement, TECNICO StockLocation type, `findByTypeAndTechnician` port, `listByLocation` views) but stopped at the depot boundary. W5a closes that gap with zero schema changes.

## Scope

### In Scope
- `ResolveTechnicianLocation(technicianId)` — find-or-create TECNICO StockLocation with P2002 race-retry
- `IssueStockToTechnician(technicianId, items[])` — operator-driven batch TRANSFER (from DEPOSITO → TECNICO); wraps `RecordInventoryMovement` with `type: 'TRANSFER'`; multi-item calls use `UnitOfWork` (all-or-nothing)
- `GetTechnicianStock(technicianId)` — assets + materials at technician location; DTO mirrors `DepotStockDto`
- `GET /api/inventory/technicians/:id/stock` (perm: `inventory.read`)
- `POST /api/inventory/technicians/:id/issue` body `{ items: [{ assetId } | { materialCatalogId, qty }] }` (perm: `inventory.write`)
- FE: `InventoryTechnicianPage` at `/admin/inventory/technicians/:id` — stock table + "Asignar stock" modal (pick from depot → POST issue)

### Out of Scope
- CAMIONETA/Vehicle type (W5b — requires migration)
- `assigned` asset status (future; assets at TECNICO location stay `available` in W5a)
- Automatic/trigger-based stock assignment (always operator-driven in W5a)
- Technician list navigation (deferred; page accepts id from URL; verify `GET /users?role=technician` before W5b)

## Capabilities

### New Capabilities
- `technician-stock`: BE use cases + REST endpoints for resolving a technician's stock location, issuing stock to technicians (TRANSFER), and querying technician stock. FE page mirroring the depot view.

### Modified Capabilities
- `service-inventory`: New routes wired into `inventory.routes.ts` and registered in `app.ts`.

## Approach

Pure application-layer addition. No Prisma schema changes.

1. **`ResolveTechnicianLocation`** — copy of `ResolveClientLocation`: `findByTypeAndTechnician('TECNICO', technicianId)` → if null, create; on P2002 retry once.
2. **`IssueStockToTechnician`** — resolve depot location (existing `ResolveDepotLocation`) + technician location (step 1) → iterate items → call `RecordInventoryMovement({ type: 'TRANSFER', fromLocationId: depot.id, toLocationId: techLoc.id, ... })` per item, wrapped in `UnitOfWork`. For ASSET: movement engine updates `currentLocationId`. For MATERIAL: atomic decrement + increment already handled by W1 ledger.
3. **`GetTechnicianStock`** — resolve technician location → `assets.listByLocation(id)` + `materialStock.listByLocation(id)` → map to `TechnicianStockDto` (same shape as `DepotStockDto`).
4. **Routes** — two handlers in `inventory.routes.ts`, auth middleware with `inventory.read` / `inventory.write`.
5. **FE** — `InventoryTechnicianPage` mirrors `InventoryDepotPage`. Stock table. "Asignar stock" button opens a modal: select items from depot stock (reuse `GetDepotStock` endpoint), submit → `POST /inventory/technicians/:id/issue`.

## Design (lightweight)

### TRANSFER vs ISSUE — critical constraint

`ISSUE` movement type = material write-off (no `toLocation`, assets forbidden). **Never use ISSUE here.** `IssueStockToTechnician` (operator language) ALWAYS calls `RecordInventoryMovement({ type: 'TRANSFER' })`. This is a naming collision that must be documented in the use case JSDoc.

### Atomicity — UnitOfWork batch

Multi-item issue wraps all `RecordInventoryMovement` calls in the existing `UnitOfWork` abstraction (same pattern as `CreateScheduledTaskWithChecklist`). If any item fails (e.g., depot out of stock), the whole batch rolls back. Single-item issue also uses `UnitOfWork` for consistency.

### Asset status post-TRANSFER

`available` status is preserved after TRANSFER in W5a. Assets are scoped by `locationId` in all list queries so no double-counting. A future `assigned` status (W5b or W6) will require a separate migration and status-transition rules — explicitly out of scope here.

### Permission model

| Action | Permission |
|--------|------------|
| View technician stock | `inventory.read` |
| Issue stock to technician | `inventory.write` |

### DTO shape

`TechnicianStockDto` mirrors `DepotStockDto` exactly, adding `technicianId: string` at root for context.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/application/use-cases/ResolveTechnicianLocation.ts` | New | find-or-create TECNICO location |
| `src/application/use-cases/IssueStockToTechnician.ts` | New | batch TRANSFER, UnitOfWork |
| `src/application/use-cases/GetTechnicianStock.ts` | New | stock view by technicianId |
| `src/application/dto/TechnicianStockDto.ts` | New | mirrors DepotStockDto |
| `src/infrastructure/http/routes/inventory.routes.ts` | Modified | 2 new route handlers |
| `src/infrastructure/http/app.ts` | Modified | no-op if already mounted |
| `src/infrastructure/adapters/in-memory/InMemoryStockLocationRepository.ts` | Verify | findByTypeAndTechnician already present |
| `ipnext-frontend/src/pages/inventory/InventoryTechnicianPage.tsx` | New | FE page |
| `ipnext-frontend/src/components/inventory/AssignStockModal.tsx` | New | issue form |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| TRANSFER/ISSUE name collision confuses implementers | Med | JSDoc on use case + spec explicitly bans ISSUE |
| `POST /users?role=technician` absent — FE has no list | Low | Page works with direct URL; list deferred to W5b |
| Race on `ResolveTechnicianLocation` under concurrent requests | Low | P2002 catch + single retry (same as ResolveClientLocation) |
| Depot out of stock mid-batch | Low | UnitOfWork rolls back; 422 with first failing item |

## Rollback Plan

All changes are additive (new use cases, new routes, new FE page). Rollback = revert the branch. No migration to undo. Routes can be commented out in `inventory.routes.ts` without affecting other features.

## Dependencies

- W1 ledger fully shipped (`RecordInventoryMovement`, `UnitOfWork`, `listByLocation`, `findByTypeAndTechnician`) — confirmed by explore.
- `ResolveDepotLocation` use case — confirmed shipped; used inside `IssueStockToTechnician`.
- FE: `GetDepotStock` endpoint reused for the "pick from depot" modal.

## Success Criteria

- [ ] `GET /api/inventory/technicians/:id/stock` returns assets + materials currently at that technician's location
- [ ] `POST /api/inventory/technicians/:id/issue` moves items from DEPOSITO to TECNICO with `type: 'TRANSFER'`; partial batch failure rolls back all items
- [ ] Asset `currentLocationId` updated after issue; materialStock incremented/decremented atomically
- [ ] `inventory.read` / `inventory.write` permissions enforced on respective endpoints
- [ ] FE page renders technician stock; "Asignar stock" modal submits successfully
- [ ] No ISSUE movement type used anywhere in the W5a code path
