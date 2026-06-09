# Exploration: inventory-client-equipment (EPIC #38, Wave 2)

## 1. Current State — What Already Exists

### Data model (Wave 1 shipped)
- `ContractInstalledItem` (CII) — the canonical per-contract installed-device roster.
  - Fields: `id`, `contractId`, `type`, `serialNumber`, `mac`, `model`, `source`, `sourceTaskId`,
    `addedByUserId`, `confirmedAt`, `status` (`active|removed|replaced`), `notes`,
    `replacesItemId`, `assetId` (FK→InventoryAsset, nullable — migrated in W1), `createdAt`.
  - 56 rows in prod; all migrated to `InventoryAsset` in W1.
- `Contract.clientId` (String, non-null FK → `Client`) — one client has many contracts.
  `@@index([clientId])` on the table.
- `InventoryAsset` — unified ledger record; `currentLocationId`→`StockLocation`
  (type=CLIENTE, `contractId`→Contract for installed assets).

### Existing port (BE)
- `ContractInventoryRepository.listByContract(contractId)` — the only query method.
  No `listByClient` method exists.

### Existing use cases (BE)
- `ListContractInstalledItems(contractId)` — resolves the approver name, returns `InstalledItemDto[]`.
  Wired to `GET /contracts/:contractId/inventory` (perm: `inventory.read`).
- `GetClientContracts(clientId)` — returns all contracts for a client
  (via `CustomerRepository.listContracts`).
- No "by-client" inventory use case exists.

### FE surface today
| File | What it does |
|------|-------------|
| `src/api/serviceInventory.api.ts` | `listServiceInstalledItems(contractId)` → `GET /contracts/:contractId/inventory`. All mutations are per-contract. |
| `src/hooks/useServiceInventory.ts` | `useServiceInstalledItems(serviceId)` — per-contract query. No multi-contract/client hook. |
| `src/pages/customers/tabs/ContractsTab.tsx:244-253` | Renders a `<ServiceInventorySection serviceId={contract.id} />` **inline under each contract row** in the Contracts tab of CustomerDetailPage. |
| `src/pages/customers/tabs/ServiceInventorySection.tsx` | Full CRUD table of installed devices per contract. Used in both ContractsTab and ServicesTab. |
| `src/pages/scheduling/SchedulingTaskDetailPage/components/ContractInventoryReadonly.tsx` | Read-only view used in the task detail sidebar ("Inventario" tab). |

**Key finding**: equipment is already visible per-contract inside `CustomerDetailPage` → "Contratos" tab. It is NOT aggregated at the client level; each contract expands its own `ServiceInventorySection`. There is NO standalone "equipos x cliente" page or tab.

### Permission pattern
- Read: `inventory.read` (maps to `Can permission="inventory.read"` in FE).
- Write: `inventory.write`.
- Route guard: `perms.contractRead` = `requirePerm('inventory', 'read')`.

---

## 2. The Data Path for "Equipos x Cliente"

### Read model recommendation: ContractInstalledItem (CII) — REUSE, enrich

CII is the correct read model for Wave 2:
- It IS the FE-facing projection (FE already reads it).
- It aggregates per contract; to get all equipment for a client → join via `Contract.clientId`.
- `assetId` FK is now set (post-W1 migration), so enrichment with asset status/location is optional/additive.
- `InventoryAsset.currentLocationId` is the materialized truth, but for a client-equipment list the relevant fields are already on CII (`serialNumber`, `mac`, `type`, `status`, `source`, `confirmedAt`).

**Two-query option** (simplest, no schema change):
```
1. GET client's contracts → contractIds[]  (CustomerRepository.listContracts)
2. For each contractId → CII.listByContract(contractId)  (ContractInventoryRepository)
Merge + decorate with contractId/plan for grouping header.
```

**Single-query option** (cleaner, one BE trip):
Add `listByClient(clientId)` to `ContractInventoryRepository` port:
```sql
SELECT cii.* FROM ContractInstalledItem cii
JOIN Contract c ON c.id = cii.contractId
WHERE c.clientId = $clientId
ORDER BY c.id, cii.createdAt
```
Returns all CII rows across the client's contracts in one shot.
Decorate each item with `contractPlan` (joined from Contract) for the FE grouping header.

**Recommendation**: single-query option — add `listByClient(clientId: string): Promise<ClientInstalledItemRow[]>` to the port where `ClientInstalledItemRow = CII + { contractPlan: string; contractType: string }`.

---

## 3. Client vs Contract Granularity

- A client has multiple contracts (`Contract.clientId`).
- Equipment lives at the contract level (CII.contractId).
- The "apartado x cliente" should **aggregate across all contracts**, grouped by contract.
  - Rationale: operators think "this client has 2 services, each with 1 router" — they want to see everything at a glance.
  - Per-contract grouping headers (`internet · Plan Fiber 100`, `voz · Plan Básico`) give context.
- FK path: `ContractInstalledItem.contractId` → `Contract.clientId` → `Client.id`.

---

## 4. FE Surface Recommendation

### Option A — Add a new "Equipos" tab on CustomerDetailPage
- Add tab `equipos` alongside the existing: Info | Contratos | Facturación | Estadísticas | ...
- The tab contains a new `ClientEquipmentTab` component.
- Grouped by contract (one accordion/section per contract).
- Each group shows a lean read-only table (type, SN, MAC, model, status, source, confirmedAt).
- Pros: dedicated surface, clean URL hash (`#equipos`), easy to find, fits the tab pattern.
- Cons: one more tab.

### Option B — Replace the inline `ServiceInventorySection` in ContractsTab with a link to Option A
- Keep inline for now, add "Ver todos los equipos" link.
- Less work, but the inline section already exists and is functional.

### Option C — New standalone page `/customers/:id/equipment`
- Like the #35 reconcile page pattern.
- Pros: full page real estate, shareable URL.
- Cons: overkill for a read-only list; harder to discover.

**Recommendation: Option A** — new "Equipos" tab on `CustomerDetailPage`. Fits the existing tab pattern, minimal routing change (just add to `TAB_IDS` + tabs array), and the user asked for "un apartado de equipos x clientes" which maps naturally to a tab.

---

## 5. Gaps — What's Missing

| Gap | Layer | Effort |
|-----|-------|--------|
| `ContractInventoryRepository.listByClient(clientId)` port method | domain/port | XS |
| `InMemoryContractInventoryRepository.listByClient()` | infrastructure/in-memory | XS |
| `PrismaContractInventoryRepository.listByClient()` | infrastructure/prisma | XS |
| `ClientInstalledItemDto` (CII + contractPlan + contractType) | application/dto | XS |
| `ListClientInstalledItems` use case | application | XS |
| `GET /clients/:clientId/equipment` route | infrastructure/http | XS |
| FE: `listClientEquipment(clientId)` in `serviceInventory.api.ts` | FE/api | XS |
| FE: `useClientInstalledItems(clientId)` hook | FE/hook | XS |
| FE: `ClientEquipmentTab` component | FE/page | S |
| FE: wire tab into `CustomerDetailPage` | FE/page | XS |

**Total effort**: Low. This is almost entirely plumbing — the data model and the read path exist; only the "by-client join" query and the FE tab are new.

---

## 6. What to REUSE

| Piece | Reuse how |
|-------|-----------|
| `ContractInventoryRepository` port | Extend — add `listByClient()` |
| `InMemoryContractInventoryRepository` | Extend — add `listByClient()` |
| `PrismaContractInventoryRepository` | Extend — add `listByClient()` |
| `InstalledItemDto` + `toInstalledItemDto()` | Extend or fork → `ClientInstalledItemDto` adds `contractPlan`, `contractType` |
| `ListContractInstalledItems` | New sibling use case `ListClientInstalledItems` following same pattern |
| `contractInventory.routes.ts` | Add new GET route in same file |
| `useServiceInventory.ts` | Add `useClientInstalledItems()` hook |
| `serviceInventory.api.ts` | Add `listClientEquipment()` fn |
| `ServiceInventorySection.tsx` | Reference for table structure; new tab builds a leaner read-only variant |

---

## 7. Approaches

### Approach 1 — Single BE endpoint (RECOMMENDED)
New `GET /clients/:clientId/equipment` → `ListClientInstalledItems` use case → `listByClient(clientId)` single Prisma query joining Contract.
- Pros: one round-trip, clean DTO with contract context, testable in isolation.
- Cons: one new port method + adapter implementation (trivial).
- Effort: Low.

### Approach 2 — FE-side fan-out
FE calls `GetClientContracts` then fans out N calls to `GET /contracts/:contractId/inventory`.
- Pros: zero BE changes.
- Cons: N+1 HTTP calls (client with 3 contracts = 4 calls), waterfall latency, no aggregate DTO.
- Effort: Low in BE, messy in FE.
- **Rejected**: N+1 anti-pattern when the BE join is trivial.

---

## 8. Risks

- **Low risk overall** — read-only feature, no mutations, no schema changes (the join uses existing FKs).
- `assetId` may be null for pre-W1 items that were added after migration without going through the W1 code path (edge case). CII fields alone are sufficient for W2; `assetId` enrichment is optional/deferred to a later wave.
- The inline `ServiceInventorySection` in ContractsTab already shows per-contract equipment. W2 adds a cross-contract view — no conflict, but the two surfaces should stay consistent (same data source, different scope).
- Permission: reuse `inventory.read` (already enforced on the per-contract route and in the FE `Can` guard). No new permission needed.

---

## Recommendation (Wave 2 scope)

**BE**: Add `listByClient(clientId)` to `ContractInventoryRepository` port + Prisma/in-memory adapters.
New use case `ListClientInstalledItems`. New route `GET /clients/:clientId/equipment` gated by `inventory.read`.
DTO: `ClientInstalledItemDto = InstalledItemDto & { contractId: string; contractPlan: string; contractType: string }`.

**FE**: New `ClientEquipmentTab` — read-only, grouped by contract, showing type/SN/MAC/model/status/source/confirmedAt. Wire as new "Equipos" tab on `CustomerDetailPage`. Add hook `useClientInstalledItems` + api fn `listClientEquipment`.

**Out of scope for W2**: mutations (add/edit/remove — those stay in the existing per-contract surface), asset ledger enrichment (W3+), materials.

### Affected Files

**BE**
- `src/domain/ports/ContractInventoryRepository.ts` — add `listByClient()`
- `src/application/dto/InstalledItemDto.ts` — add `ClientInstalledItemDto`
- `src/application/use-cases/ListClientInstalledItems.ts` — new use case
- `src/infrastructure/adapters/in-memory/InMemoryContractInventoryRepository.ts` — impl
- `src/infrastructure/adapters/prisma/PrismaContractInventoryRepository.ts` — impl
- `src/infrastructure/http/routes/contractInventory.routes.ts` — new GET route
- `src/infrastructure/http/app.ts` — wire use case
- `src/__tests__/application/ServiceInventory.test.ts` — extend with ListClientInstalledItems tests
- `src/__tests__/infrastructure/serviceInventory.routes.test.ts` — extend with route test

**FE**
- `src/api/serviceInventory.api.ts` — add `listClientEquipment(clientId)`
- `src/hooks/useServiceInventory.ts` — add `useClientInstalledItems(clientId)`
- `src/pages/customers/tabs/ClientEquipmentTab.tsx` — new component
- `src/pages/customers/CustomerDetailPage.tsx` — wire tab

### Ready for Proposal
Yes. Scope is clear, data model exists, effort is low, risk is low (read-only). The only decision left for proposal: confirm that "Equipos" tab aggregates ALL contracts (active + inactive) or only active — recommend ALL (filtered by status in the FE with a toggle, defaulting to active+removed for full history).
