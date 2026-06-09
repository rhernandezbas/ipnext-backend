# Proposal: Inventory Dashboard (EPIC #38 Wave 7 — Capstone)

## Intent

Close EPIC #38 with a read-only operator dashboard over World B inventory: a global location view, a filterable movement ledger, and low-stock alerts. Simultaneously retire World A (legacy inventory) dead code so operators see one coherent surface. Prod data is sparse (56 assets, empty depot, 0 TECNICO/CAMIONETA, ~57 movements, 7 materials) — empty states are first-class.

## Scope

### In Scope
- Additive migration: `minStock Int @default(0)` on `MaterialCatalog` (0 = no alert); editable in existing Materials ABM (BE DTO + FE form).
- `GET /api/inventory/overview/locations` — global view grouped by location type (DEPOSITO/cliente/técnico/camioneta) with resolved labels, counts, qty; single aggregation query.
- `GET /api/inventory/movements` — offset pagination (page/limit, default 25), filters: type, locationId, materialCatalogId, taskId, date range; order `occurredAt DESC`.
- `GET /api/inventory/alerts` — materials where SUM(stock.qty) < minStock AND minStock > 0.
- FE: rewrite `InventoryDashboardPage` as one page, 3 tabs (Ubicaciones / Movimientos / Alertas) at existing route `/admin/inventory/dashboard` (perm `inventory.read`), replacing the World A shell.
- World A cleanup (isolated task group, no DROP): remove dead FE pages/routes + BE use cases; trim only World A methods from `EmpresaRepository` (ServicePlan/NetworkDevice untouched). Sidebar → Dashboard, Devoluciones, Descuentos pendientes, Camionetas, Configuración.

### Out of Scope
- DROP of World A tables (deprecated-without-drop; possible future minimal migration).
- Per-location alerts, exports/reports, websockets/live refresh.
- Touching W4/W6 flags.

## Capabilities

### New Capabilities
- `inventory-dashboard`: read-only overview (locations grouped/labeled with counts+qty), paginated filterable movement ledger, and global low-stock alerts; covers the 3 new read endpoints + empty states.
- `inventory-min-stock`: `minStock` on `MaterialCatalog` (additive), ABM edit, and the alert derivation rule.

### Modified Capabilities
- None (World A cleanup is code removal of an unspecified legacy surface; no spec'd requirement changes).

## Approach

Hexagonal, additive, TDD. New port methods: `StockLocationRepository.listWithContent()` (single aggregation, avoids N+1), `InventoryMovementRepository.listMovements(filters, pagination)`, `MaterialCatalogRepository.listLowStock()` — each with Prisma + InMemory parity. Three new use cases + DTOs. Add `@@index([type, occurredAt])`. Cleanup runs last as an isolated, mechanical task block.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modified | `minStock` on MaterialCatalog; composite index on movements |
| `src/domain/ports/{StockLocation,InventoryMovement,MaterialCatalog}Repository.ts` | Modified | New read methods |
| `src/application/use-cases/` | New | GetInventoryDashboard, ListInventoryMovements, GetStockAlerts |
| `src/infrastructure/adapters/{prisma,in-memory}/` | Modified | Implement new methods (parity) |
| `src/infrastructure/http/routes/inventory.routes.ts` | Modified | 3 new GET routes |
| FE `InventoryDashboardPage`, `inventory.api.ts`, `useInventory.ts`, Sidebar, App.tsx | Modified | Tabbed page; nav cleanup |
| World A use cases + `EmpresaRepository` (partial) + FE legacy pages | Removed | Dead-code removal |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Cleanup blast radius (EmpresaRepository shared) | Med | Surgical: remove only World A methods; if regression risk high, leave methods dead, remove only routes/use cases/pages |
| N+1 on global view | Med | Single aggregation query in adapter, not per-location iteration |
| Dashboard route replaced in place | Low | Same route + `inventory.read`; new page is additive UI |

## Rollback Plan

Revert the PR(s). The `minStock` migration is additive (`@default(0)`) — leaving the column is harmless; no destructive migration to undo. No World A tables dropped, so legacy data stays intact.

## Dependencies

- W1–W6 World B stack (StockLocation, InventoryAsset, MaterialStock, InventoryMovement) already in prod.

## Success Criteria

- [ ] 3 read endpoints live under `/api/inventory`, all with InMemory + Prisma parity tests.
- [ ] `minStock` editable in Materials ABM; alerts fire only when minStock > 0.
- [ ] Dashboard tabs render correct labels/counts/qty with graceful empty states (0 TECNICO/CAMIONETA).
- [ ] World A pages/routes/use cases removed; sidebar shows 5 items; no DROP TABLE; build/tests green.
