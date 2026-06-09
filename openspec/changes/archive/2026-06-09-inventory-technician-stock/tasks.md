# Tasks: Inventory — Technician Stock (W5a)

## Batch A — Backend

### Phase A1: DTO + Use Cases (TDD — RED first)

- [x] A1.1 **[RED]** Write `src/__tests__/application/ResolveTechnicianLocation.test.ts` — covers: finds existing TECNICO location; creates new location when absent; retries once on P2002 and returns the winner.
- [x] A1.2 **[GREEN]** Create `src/application/use-cases/ResolveTechnicianLocation.ts` — copy `ResolveClientLocation`; swap `findByType` for `findByTypeAndTechnician('TECNICO', technicianId)`; P2002 catch + single retry.
- [x] A1.3 Create `src/application/dto/TechnicianStockDto.ts` — mirrors `DepotStockDto` shape, adds `technicianId: string` at root.
- [x] A1.4 **[RED]** Write `src/__tests__/application/GetTechnicianStock.test.ts` — covers: returns assets + materials at location; null location → empty DTO (no create on GET); DTO shape matches `TechnicianStockDto`.
- [x] A1.5 **[GREEN]** Create `src/application/use-cases/GetTechnicianStock.ts` — clone `GetDepotStock`; resolve via `findByTypeAndTechnician` (null → return empty DTO, no create); map to `TechnicianStockDto`.
- [x] A1.6 **[RED]** Write `src/__tests__/application/IssueStockToTechnician.test.ts` — covers: asset transfer updates `currentLocationId`; material transfer decrements depot + increments tecnico; insufficient depot stock → rejected, no partial apply; multi-item atomic rollback when one item fails; asset not at depot → rejected.
- [x] A1.7 **[GREEN]** Create `src/application/use-cases/IssueStockToTechnician.ts` — resolve depot + technician locations; iterate items; call `RecordInventoryMovement({ type: 'TRANSFER', ... })` per item inside `UnitOfWork`; JSDoc: **TRANSFER not ISSUE** — naming collision documented.

### Phase A2: Routes + Wiring

- [x] A2.1 **[RED]** Extend `src/__tests__/infrastructure/inventory.routes.test.ts` — `GET /api/inventory/technicians/:id/stock`: 200 shape; 403 without `inventory.read`. `POST /api/inventory/technicians/:id/issue`: 200 on valid payload; 403 without `inventory.write`; 422 on insufficient stock (atomic rollback verified).
- [x] A2.2 **[GREEN]** Add two handlers to `src/infrastructure/http/routes/inventory.routes.ts` — `GET /technicians/:id/stock` → `GetTechnicianStock`; `POST /technicians/:id/issue` → `IssueStockToTechnician`; auth middleware with correct perms.
- [x] A2.3 Verify `src/infrastructure/http/app.ts` already mounts `inventory.routes`; add mount only if absent.
- [x] A2.4 **[VERIFY]** Run `npx jest` — all A-phase tests green; run `npx tsc --noEmit` — zero type errors.

## Batch B — Frontend

### Phase B1: API + Hooks (TDD — RED first)

- [x] B1.1 Add `getTechnicianStock(technicianId)` and `issueStockToTechnician(technicianId, items)` to the inventory API module (mirror depot equivalents).
- [x] B1.2 **[RED]** Write hook tests — `useTechnicianStock`: returns data, loading, empty state. `useIssueStock`: calls API, invalidates technician stock query on success.
- [x] B1.3 **[GREEN]** Create `useTechnicianStock` and `useIssueStock` hooks (mirror `useDepotStock` / depot issue hook).

### Phase B2: Page + Modal (TDD — RED first)

- [x] B2.1 **[RED]** Write `InventoryTechnicianPage.test.tsx` — renders stock table; renders "Asignar stock" button; shows empty state; gates button on `inventory.write` perm; renders `AssignStockModal` on click.
- [x] B2.2 **[GREEN]** Create `src/pages/inventory/InventoryTechnicianPage.tsx` — mirrors `InventoryDepotPage`; stock table (assets + materials); "Asignar stock" button → opens `AssignStockModal`.
- [x] B2.3 **[RED]** Write `AssignStockModal.test.tsx` — lists depot items for selection; submit calls `useIssueStock`; disables submit while in-flight; closes on success.
- [x] B2.4 **[GREEN]** Create `src/components/inventory/AssignStockModal.tsx` — fetches depot stock for picker; multi-select; POST to issue endpoint; invalidate + close on success.
- [x] B2.5 Register route `/admin/inventory/technicians/:id` in the FE router.
- [x] B2.6 **[VERIFY]** Run `npx vitest run` — all B-phase tests green; run `npm run typecheck` — zero errors.
