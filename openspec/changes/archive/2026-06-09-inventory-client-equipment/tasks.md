# Tasks: Inventory — Client Equipment View (EPIC #38, Wave 2)

<!-- Cross-repo contract: BE route GET /api/clients/:clientId/equipment must ship before FE Batch B -->

## Batch A — Backend (TDD: red → green → refactor)

### Phase A1: Foundation

- [x] A1.1 **[RED]** `src/__tests__/application/ServiceInventory.test.ts` — add failing test: `ListClientEquipment` with in-memory repo returns `ClientInstalledItemDto[]` grouped by contractId (client with 2 contracts → items from both; empty client → [])
- [x] A1.2 `src/application/dto/InstalledItemDto.ts` — add `ClientInstalledItemDto` interface (extends existing fields + `contractId`, `contractPlan`, `contractType`)
- [x] A1.3 `src/domain/ports/ContractInventoryRepository.ts` — add `listByClient(clientId: string): Promise<ClientInstalledItemRow[]>` method signature + `ClientInstalledItemRow` type
- [x] A1.4 `src/infrastructure/adapters/in-memory/InMemoryContractInventoryRepository.ts` — implement `listByClient`: filter CIIs whose contractId belongs to a contract with matching clientId; decorate with contractPlan/contractType

### Phase A2: Core Implementation

- [x] A2.1 **[GREEN]** `src/application/use-cases/ListClientEquipment.ts` — new use case; calls `repo.listByClient(clientId)`; maps rows to `ClientInstalledItemDto[]`; never returns raw entities
- [x] A2.2 Verify A1.1 tests pass (`npx jest ServiceInventory`)
- [x] A2.3 **[RED]** `src/__tests__/infrastructure/serviceInventory.routes.test.ts` — add failing route tests: `GET /api/clients/:clientId/equipment` → 200 with correct DTO shape; 403 missing `inventory.read` (401-unauth not testable in this builder — guard pattern matches existing suite which asserts 403)
- [x] A2.4 `src/infrastructure/adapters/prisma/PrismaContractInventoryRepository.ts` — implement `listByClient`: single `findMany` JOIN `CII ⋈ Contract WHERE clientId`, `include: { contract: { select: { plan, type } } }`, ordered by `contractId asc, createdAt asc`

### Phase A3: Wiring

- [x] A3.1 `src/infrastructure/http/routes/contractInventory.routes.ts` — add `GET /clients/:clientId/equipment` handler: `perms.contractRead` (= `requirePerm('inventory','read')`) → `ListClientEquipment` → return DTO array
- [x] A3.2 `src/infrastructure/http/app.ts` — wire `ListClientEquipment` use case into the router (inject `PrismaContractInventoryRepository`)
- [x] A3.3 **[GREEN]** Verify A2.3 route tests pass (`npx jest serviceInventory.routes`)
- [x] A3.4 `npx tsc --noEmit` — zero type errors on BE

---

## Batch B — Frontend (depends on BE route shipping)

### Phase B1: API + Hook

- [x] B1.1 **[RED]** Write failing test for `useClientInstalledItems(clientId)`: returns `[]` when API → 404 (GC-7 convention); returns items on 200
- [x] B1.2 `src/api/serviceInventory.api.ts` — add `listClientEquipment(clientId: string): Promise<ClientInstalledItemDto[]>` fn; calls `GET /api/clients/:clientId/equipment`
- [x] B1.3 `src/hooks/useServiceInventory.ts` — add `useClientInstalledItems(clientId)` hook; uses `listClientEquipment`; returns `[]` on 404
- [x] B1.4 **[GREEN]** Verify B1.1 hook tests pass (`npx vitest run useServiceInventory`)

### Phase B2: Component

- [x] B2.1 **[RED]** `src/pages/customers/tabs/ClientEquipmentTab.test.tsx` — add failing tests: renders items grouped by contract; shows empty state when `[]`; active items normal, `removed`/`replaced` dimmed
- [x] B2.2 `src/pages/customers/tabs/ClientEquipmentTab.tsx` — new component; uses `useClientInstalledItems`; renders `ContractEquipmentGroup` per contractId (header: plan + type); read-only table columns: type | SN | MAC | model | StatusBadge | source | confirmedAt; status badges: active=green, removed/replaced=muted
- [x] B2.3 **[GREEN]** Verify B2.1 tests pass (`npx vitest run ClientEquipmentTab`)

### Phase B3: Wiring + Typecheck

- [x] B3.1 `src/pages/customers/CustomerDetailPage.tsx` — add "Equipos" tab entry; render `<ClientEquipmentTab clientId={clientId} />`; guard with `<Can perm="inventory.read">`
- [x] B3.2 Mirror existing `CustomerDetailPage` tab tests — add test: "Equipos" tab is present for users with `inventory.read`; absent without
- [x] B3.3 `npm run typecheck` — zero FE type errors
