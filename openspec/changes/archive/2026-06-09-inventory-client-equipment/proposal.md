# Proposal: Inventory — Client Equipment View (EPIC #38, Wave 2)

## Intent

Operators need a single aggregated view of all equipment installed across a client's contracts. Today, equipment is visible per-contract inside the "Contratos" tab, but there is no cross-contract summary. This causes operational friction when a client has multiple active services. Read-only; no mutations.

## Scope

### In Scope
- BE: `ContractInventoryRepository.listByClient(clientId)` — port method + Prisma + InMemory adapters
- BE: `ClientInstalledItemDto` (extends `InstalledItemDto` with `contractId`, `contractPlan`, `contractType`)
- BE: `ListClientEquipment` use case
- BE: `GET /api/clients/:clientId/equipment` route, guarded by `inventory.read`
- FE: `listClientEquipment(clientId)` api fn in `serviceInventory.api.ts`
- FE: `useClientInstalledItems(clientId)` hook in `useServiceInventory.ts`
- FE: `ClientEquipmentTab` component — read-only, grouped by contract, status badges
- FE: Wire as new "Equipos" tab on `CustomerDetailPage`

### Out of Scope
- Any mutation (add/edit/remove equipment — stays in per-contract `ServiceInventorySection`)
- Asset ledger enrichment (`InventoryAsset` fields beyond what CII carries) — Wave 3+
- The existing per-contract `ServiceInventorySection` in ContractsTab — untouched

## Decisions (settled — design phase skippable)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | All contracts vs active-only | **ALL** with status visible | Operators need the full history; active items shown prominently, removed/replaced dimmed |
| 2 | Permission | **`inventory.read`** (existing) | Already gates `GET /contracts/:contractId/inventory` and FE `Can` guard; no new perm needed |
| 3 | DTO shape | `{ id, type, serialNumber, mac, model, status, source, confirmedAt, contractId, contractPlan, contractType, assetId }` | Extends current `InstalledItemDto`; adds contract context for grouping |
| 4 | Grouping | By `contractId`, header shows `contractPlan + contractType` | Matches operator mental model of "service" |
| 5 | BE query | Single JOIN: `CII ⋈ Contract WHERE clientId` | Avoids N+1; existing FK + index make it trivial |

## Capabilities

### New Capabilities
- `client-equipment-view`: Aggregated read-only view of all installed equipment across a client's contracts — BE endpoint + FE tab

### Modified Capabilities
- `service-inventory`: Extend `ContractInventoryRepository` port with `listByClient()`; add `ClientInstalledItemDto`

## Approach

Extend the existing `ContractInventoryRepository` port with one new method. Add a sibling use case to `ListContractInstalledItems`. Add a new route in the existing `contractInventory.routes.ts`. On the FE, add a hook + api fn following the existing `useServiceInventory` pattern, and a new `ClientEquipmentTab` component wired as the "Equipos" tab on `CustomerDetailPage`.

No schema migration required — all FKs and indexes already exist.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/domain/ports/ContractInventoryRepository.ts` | Modified | Add `listByClient(clientId)` |
| `src/application/dto/InstalledItemDto.ts` | Modified | Add `ClientInstalledItemDto` |
| `src/application/use-cases/ListClientEquipment.ts` | New | Use case |
| `src/infrastructure/adapters/in-memory/InMemoryContractInventoryRepository.ts` | Modified | Implement `listByClient` |
| `src/infrastructure/adapters/prisma/PrismaContractInventoryRepository.ts` | Modified | Implement `listByClient` (JOIN query) |
| `src/infrastructure/http/routes/contractInventory.routes.ts` | Modified | Add `GET /clients/:clientId/equipment` |
| `src/infrastructure/http/app.ts` | Modified | Wire `ListClientEquipment` use case |
| `src/__tests__/application/ServiceInventory.test.ts` | Modified | Add use case tests (TDD) |
| `src/__tests__/infrastructure/serviceInventory.routes.test.ts` | Modified | Add route test |
| `src/api/serviceInventory.api.ts` | Modified | Add `listClientEquipment(clientId)` |
| `src/hooks/useServiceInventory.ts` | Modified | Add `useClientInstalledItems(clientId)` |
| `src/pages/customers/tabs/ClientEquipmentTab.tsx` | New | Read-only tab component |
| `src/pages/customers/CustomerDetailPage.tsx` | Modified | Wire "Equipos" tab |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| FE tab renders before BE is deployed | Low | Hook returns empty array on 404; tab shows empty state gracefully (per GC-7) |
| `assetId` null on pre-W1 items | Low | `assetId` is nullable in DTO — FE handles null; not displayed in this view |
| InMemory adapter `listByClient` joins in-memory | Low | Standard pattern — filter CIIs whose contractId matches a contract in the repo |

## Rollback Plan

- BE: revert the route registration in `app.ts` and remove the new route from `contractInventory.routes.ts`. Port method and use case can stay (additive). No DB changes to revert.
- FE: remove the "Equipos" tab entry from `CustomerDetailPage` — the component file can stay without being rendered.

## Dependencies

- Wave 1 `assetId` migration must be complete (it is — 56/56 rows migrated).
- `inventory.read` permission must exist in RBAC (confirmed — already seeded and in use).

## Success Criteria

- [ ] `GET /api/clients/:clientId/equipment` returns all CII rows across the client's contracts, each decorated with `contractPlan` and `contractType`
- [ ] Route returns `403` when caller lacks `inventory.read`
- [ ] FE "Equipos" tab renders items grouped by contract with `status` badge (active = normal, removed/replaced = dimmed)
- [ ] Items from ALL contracts (active and inactive) are shown
- [ ] The existing per-contract `ServiceInventorySection` in ContractsTab is unchanged
- [ ] All new BE logic covered by tests (TDD: red → green → refactor)

## Design (lightweight)

### DTO

```typescript
// Extends existing InstalledItemDto
export interface ClientInstalledItemDto {
  id: string;
  type: string;
  serialNumber: string | null;
  mac: string | null;
  model: string | null;
  status: 'active' | 'removed' | 'replaced';
  source: string;
  confirmedAt: string | null;
  assetId: string | null;
  // contract context (new fields)
  contractId: string;
  contractPlan: string;
  contractType: string;
}
```

### Port method

```typescript
listByClient(clientId: string): Promise<ClientInstalledItemRow[]>;
// where ClientInstalledItemRow = ContractInstalledItem & { contractPlan: string; contractType: string }
```

### Prisma query (single JOIN)

```typescript
prisma.contractInstalledItem.findMany({
  where: { contract: { clientId } },
  include: { contract: { select: { id: true, plan: true, type: true } } },
  orderBy: [{ contractId: 'asc' }, { createdAt: 'asc' }],
})
```

### Permission gate

`requirePerm('inventory', 'read')` — same middleware already used on `GET /contracts/:contractId/inventory`.

### FE component structure

```
ClientEquipmentTab
  └── per contract: ContractEquipmentGroup (header: plan + type)
        └── read-only table: type | SN | MAC | model | StatusBadge | source | confirmedAt
```

Status badges: `active` → green, `removed` → muted/strikethrough, `replaced` → muted.
