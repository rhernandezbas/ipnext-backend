# Design — `contratos-naming-be` (Service → Contract, REBUILT on origin/main)

> ANCHOR change. Defines the wire the other 3 backend/frontend changes consume.
> Base: `origin/main` = `0bddf7d1`. Design-only — no production code here.

## 0. Intent & non-negotiable rule

**RENAME-ONLY. ZERO functionality removed.** Every feature that exists on origin
(`Service` listing, `/stats`, per-client services, GR ingest, iClass→inventory,
ServiceTechnology catalog, contracts RBAC module, scheduling FK) keeps working
exactly as today. The DB table `Service` becomes `Contract`; the field `serviceId`
becomes `contractId` EVERYWHERE; the wire moves LOCKSTEP with the frontend (no alias).

This supersedes the prior reassessment (engram #606) that recommended abandoning the
DB rename. The architect has fixed the contract: the rename DOES happen, physically,
in lockstep. This design rebuilds the v1 rename on top of origin's NEW objects
(`ServiceInstalledItem`, `ServiceTechnology`, `Service.technology`, the `contracts`
RBAC module) which did not exist on the v1 base.

## 1. PINNED SHARED CONTRACT (the wire — do not deviate)

| Concern | Before (origin) | After (this change) |
|---|---|---|
| DB table | `Service` | `Contract` |
| Prisma model | `model Service` | `model Contract` |
| Prisma client accessor | `prisma.service` | `prisma.contract` |
| FK column on `ScheduledTask` | `serviceId` | `contractId` |
| FK column on `ServiceInstalledItem` | `serviceId` | `contractId` |
| Per-client listing route | `GET /api/clients/:id/services` | `GET /api/clients/:id/contracts` |
| Global listing route | `GET /api/services` | `GET /api/contracts` |
| Stats route | `GET /api/services/stats` | `GET /api/contracts/stats` |
| Per-contract route (id) | `…/services/:id` | `…/contracts/:id` |
| Inventory route | `GET/POST/PATCH /api/services/:serviceId/inventory…` | `…/contracts/:contractId/inventory…` |
| Per-client CRUD stub | `…/services/:serviceId` (clients.routes stub) | `…/contracts/:contractId` |
| Payload FK key | `serviceId` | `contractId` |
| Error code (task FK) | `SERVICE_NOT_FOUND` | `CONTRACT_NOT_FOUND` |
| Stub error code | `SERVICE_NOT_FOUND` (clients.routes) | `CONTRACT_NOT_FOUND` |
| Richer label data | (already) `Contract.technology` | KEEP — use the REAL `technology` field, NO FE heuristic |

`technology` already carries the structured catalog name (origin's `ServiceTechnology`
catalog → free-text name on the row). This change does NOT introduce any FE-side
plan-text derivation; the column stays the source of the label.

## 2. Model-name boundary decisions (architect-fixed, justified)

### AD-1 — `Service` → `Contract` (RENAME)
The business concept the user calls "Contrato". Table, model, accessor, all symbols.
This is the whole point of the change.

### AD-2 — `ServiceInstalledItem` → `ContractInstalledItem` (RENAME)
**Justification:** this table's `serviceId` FK references `Service.id` — it models the
inventory **on a contract**. Its own entity doc literally says *"Confirmed inventory on
the client's contract"*. Renaming `serviceId → contractId` without renaming the owning
model would leave a `ContractInstalledItem`-shaped concept called `Service*`, which is
exactly the naming debt we are paying off. RENAME the model + table + FK + indexes +
the TS entity + port + adapters + use-cases + routes. The Prisma accessor moves
`prisma.serviceInstalledItem` → `prisma.contractInstalledItem`.

### AD-3 — `ServiceTechnology` → `ContractTechnology` (RENAME)
**Justification:** it is the catalog of technologies a **contract** can have; the column
it backs (`Service.technology` → `Contract.technology`) travels with the `Contract`
rename. Keeping the catalog called `ServiceTechnology` while the column lives on
`Contract` splits one concept across two names. RENAME table (`@@map`), model, accessor
(`prisma.serviceTechnology` → `prisma.contractTechnology`), entity, port, DTO, error,
use-cases, route file, and the `/api/...` mount IF it is currently `/service-technologies`
(verify the mount path; the route file is `serviceTechnologies.routes.ts`). **Wire note:**
the technology catalog endpoint is NOT in the pinned 4-route lockstep list. Its URL move
(`/service-technologies` → `/contract-technologies`, if applicable) is part of THIS change
and must be coordinated with the FE the same lockstep way; if the FE does not consume a
separate catalog endpoint under that name, the URL is internal-only and renames freely.
**Confirm the exact catalog mount path during apply** before committing to its URL move.

### AD-4 — `ServicePlan` → **KEEP** (do NOT rename)
**Justification:** `ServicePlan` (NETWORK domain) is a tariff/plan catalog
(download/upload speed, price, billingCycle, subscriberCount). It is a DIFFERENT concept
from a customer's `Contract`. It has no FK to `Service`/`Contract`. Renaming it would be
semantically WRONG and out of scope. Leave `model ServicePlan`, `prisma.servicePlan`,
`ServicePlan*` use-cases, and `PrismaEmpresaRepository.servicePlan` usages untouched.

### AD-5 — Splynx external wire → **KEEP** (do NOT rename)
**Justification:** `SplynxCustomerAdapter.listServices()` and the Splynx
`/internet-service` endpoint model the EXTERNAL Splynx API contract. Renaming them would
break the integration's wire to a third-party system we do not control. Leave the Splynx
adapter's `listServices`/`SplynxService`/`/internet-service` untouched. (The
`CustomerRepository.listServices` PORT method DOES get renamed — see AD-6 — because that
is OUR internal contract; the Splynx adapter implements the renamed port method but keeps
its own external URL string.)

### AD-6 — Internal port/use-case identifiers → RENAME for consistency
`CustomerRepository.listServices` → `listContracts`; `GetClientServices` →
`GetClientContracts`; `ListServices` → `ListContracts`; `GetServiceStats` →
`GetContractStats`; `ServiceRepository` (port) → `ContractRepository`; `ServiceListItem`
→ `ContractListItem`; `ListServicesQuery` → `ListContractsQuery`; `ServiceStats` →
`ContractStats`; `ServiceInventoryRepository` → `ContractInventoryRepository`;
`ListServiceInstalledItems` → `ListContractInstalledItems`. The `customer.ts` `Service`
entity interface → `Contract`. These are internal symbols; rename them so the codebase
reads consistently. DTO file `contract.dto.ts` and its types (`ContractSummaryDto`,
`PaginatedContractsDto`) are ALREADY correctly named — leave as-is.

### AD-7 — clients.routes.ts in-memory stub → RENAME for consistency (do NOT delete)
The `POST/PATCH/DELETE /:id/services` block in `clients.routes.ts` is an in-memory
CRUD stub (`servicesOverrideStore`, local `Service` interface, `SERVICE_NOT_FOUND`).
It stays functionally identical but is renamed to `/contracts` + `CONTRACT_NOT_FOUND`
to honor the lockstep wire and avoid a `/services` URL surviving the rename. Zero
behavior change.

### AD-8 — `Stage`/`Service order` (iClass) → **KEEP** (do NOT rename)
The iClass "Service Order" objects (`IClassServiceOrder`, `IClassSoStatusHistory`,
`getServiceOrders`, `BackfillClosedServiceOrders`, `ClosedServiceOrderRepository`,
`closedServiceOrder`, etc.) model iClass's external "Ordem de Serviço" concept — NOT a
customer Contract. The token "service" there refers to a field-service order. Leave ALL
`*ServiceOrder*` symbols and the GR `getServiceOrders` untouched. Only `serviceId` (the
FK to the contract) inside the GR-ingest payload and the `GrLinkResolverPort` becomes
`contractId` / `findContractByGrContratoId` (AD-9).

### AD-9 — GR link resolver → RENAME the contract-resolution method
`GrLinkResolverPort.findServiceByGrContratoId` → `findContractByGrContratoId`;
`PrismaGrLinkResolver` impl + `InMemoryGrLinkResolver` follow. The `IngestGestionRealOrders`
local var `service` → `contract`, and the `createTask({ serviceId: service.id })` payload
key → `contractId: contract.id`. `getServiceOrders` (the GR API call) is AD-8 — KEEP.

## 3. Full rename surface on CURRENT origin (authoritative checklist)

### 3.1 Prisma schema (`prisma/schema.prisma`)
- `model Service` → `model Contract` (block at ~L207). Update `Client.services Service[]`
  → `Client.contracts Contract[]` back-relation (L189) and its field name.
- `ScheduledTask.serviceId/service Service?` → `contractId/contract Contract?` (L834-835)
  + `@@index([serviceId])` → `@@index([contractId])` (L880).
- `ServiceInstalledItem` model → `ContractInstalledItem`; `serviceId/service Service`
  → `contractId/contract Contract` (L743-746); both `@@index` (L760-761) →
  `contractId`/(serialNumber unchanged name token but on renamed model).
- `Contract.installedItems ServiceInstalledItem[]` → `ContractInstalledItem[]` (L224).
- `ServiceTechnology` model + `@@map("ServiceTechnology")` → `ContractTechnology` +
  `@@map("ContractTechnology")` (L499-507).
- `Contract.technology` comment text mentions "ServiceTechnology catalog" → update prose
  (L220, L498).
- **KEEP:** `ServicePlan` (L1001), all `IClass*ServiceOrder*`/`IClassSoType` blocks.

### 3.2 Domain (`src/domain`)
- `entities/customer.ts`: `interface Service` → `interface Contract` (L28). Update
  `CustomerRepository` import.
- `entities/service-installed-item.ts` → rename file to `contract-installed-item.ts`;
  `ServiceInstalledItem` → `ContractInstalledItem`; field `serviceId` → `contractId`.
- `entities/serviceTechnology.ts` → `contractTechnology.ts`; type rename.
- `ports/ServiceRepository.ts` → `ContractRepository.ts`; `ServiceRepository`,
  `ServiceListItem`, `ListServicesQuery`, `ServiceStats` → `Contract*`. `list`/`stats`
  signatures unchanged.
- `ports/ServiceInventoryRepository.ts` → `ContractInventoryRepository.ts`; `listByService`
  → `listByContract(contractId)`; entity import → `ContractInstalledItem`.
- `ports/ServiceTechnologyRepository.ts` → `ContractTechnologyRepository.ts`.
- `ports/CustomerRepository.ts`: `listServices` → `listContracts`; `Service` import →
  `Contract`.
- `ports/GrLinkResolverPort.ts`: `findServiceByGrContratoId` → `findContractByGrContratoId`;
  prose.
- `errors/scheduling.ts`: `ReferenceKind` `'service'` → `'contract'` (L3).
- `errors/serviceTechnology.ts` → `contractTechnology.ts`; error class names.
- **KEEP:** `errors/scheduling.ts` other kinds; `ports/ClosedServiceOrderRepository.ts`
  (iClass SO — AD-8).

### 3.3 Application (`src/application`)
- `use-cases/ListServices.ts` → `ListContracts.ts`; class `ListServices` → `ListContracts`;
  import `ServiceRepository` → `ContractRepository`.
- `use-cases/GetServiceStats.ts` → `GetContractStats.ts`.
- `use-cases/GetClientServices.ts` → `GetClientContracts.ts`; `repo.listServices` →
  `repo.listContracts`; `Service` import → `Contract`.
- `use-cases/ListServiceInstalledItems.ts` → `ListContractInstalledItems.ts`;
  `listByService` → `listByContract`; param `serviceId` → `contractId`.
- `use-cases/AddInstalledItemManually.ts`: input field `serviceId` → `contractId`.
- `use-cases/ConfirmInventorySuggestion.ts`: `const serviceId = task?.serviceId` →
  `contractId = task?.contractId`; `TaskHasNoServiceError` → consider
  `TaskHasNoContractError` (rename for consistency; keep behavior); item `serviceId` →
  `contractId`.
- `use-cases/CreateTask.ts`: `serviceLookup` → `contractLookup`; `data.serviceId` →
  `data.contractId`; `ReferenceNotFoundError('service', …)` → `'contract'`.
- `use-cases/UpdateTask.ts`: same `serviceLookup`/`data.serviceId`/`'service'` →
  contract.
- `use-cases/Service*Technology` (`CreateServiceTechnology`, `GetServiceTechnology`,
  `ListServiceTechnology`, `UpdateServiceTechnology`, `DeleteServiceTechnology`) →
  `*ContractTechnology`.
- `use-cases/IngestGestionRealOrders.ts`: local `service`/`findServiceByGrContratoId`/
  `serviceId: service.id` → contract.
- `dto/scheduling.dto.ts`: `serviceId` (base optional + CreateTaskSchema required) →
  `contractId` (L65, L87); comments REQ-REQUIRED prose.
- `dto/gestionRealIngest.dto.ts`: `serviceId` field + mapping (L128, L144) → `contractId`.
- `dto/serviceTechnology.dto.ts` → `contractTechnology.dto.ts`.
- `dto/contract.dto.ts`: ALREADY correct — leave.
- **KEEP:** `ServicePlan` use-cases (`CreateServicePlan`, etc.); `BackfillClosedServiceOrders`,
  `IngestClosedServiceOrders`, `SyncGestionRealContracts` (already "Contracts"!), iClass.
  `SchedulingRepository.CreateTaskInput` is `Omit<ScheduledTask,...>` so renaming the
  entity field cascades — verify the `serviceId` token does not appear in the Omit list
  (it does not).

### 3.4 Infrastructure — adapters (`src/infrastructure/adapters`)
- `prisma/PrismaServiceRepository.ts` → `PrismaContractRepository.ts`; class rename;
  `(prisma as any).service` → `prisma.contract` (×3: findMany, count, groupBy) — and the
  rename lets us DROP the `as any` cast (the generated client will have `.contract`).
- `prisma/PrismaServiceInventoryRepository.ts` → `PrismaContractInventoryRepository.ts`;
  `prisma.serviceInstalledItem` → `prisma.contractInstalledItem` (×4); `serviceId` →
  `contractId`; `listByService` → `listByContract`.
- `prisma/PrismaServiceTechnologyRepository.ts` → `PrismaContractTechnologyRepository.ts`;
  `(prisma as any).service.count({ where: { technology }})` → `prisma.contract.count`.
- `prisma/PrismaCustomerRepository.ts`: `listServices` → `listContracts`;
  `prisma.service.findMany` → `prisma.contract.findMany` (L195-196); `Service` import →
  `Contract`.
- `prisma/PrismaClientMirrorRepository.ts`: `prisma.service.findUnique/update/create`
  (L86,106,110) → `prisma.contract.*`.
- `prisma/PrismaGrLinkResolver.ts`: `prisma.service.findUnique` (L22) → `prisma.contract`;
  method rename per AD-9; `service` var → `contract`.
- `prisma/PrismaMirrorCountsRepository.ts`: `prisma.service.count` (L10) → `prisma.contract`.
- `prisma/PrismaSchedulingRepository.ts`: `serviceId` mappings (L80, L455, L491) →
  `contractId`; any `include`/`select` of the renamed relation (`service` → `contract`)
  in toTask — verify the include block.
- `in-memory/InMemoryServiceRepository.ts` → `InMemoryContractRepository.ts`.
- `in-memory/InMemoryServiceInventoryRepository.ts` → `InMemoryContractInventoryRepository.ts`;
  `listByService`/`i.serviceId` → contract.
- `in-memory/InMemoryServiceTechnologyRepository.ts` → `InMemoryContractTechnologyRepository.ts`.
- `in-memory/InMemorySchedulingRepository.ts`: `serviceId` (L60, L268, L317) → `contractId`.
- `in-memory/InMemoryGrLinkResolver.ts`: method rename per AD-9.
- `splynx/SplynxCustomerAdapter.ts`: implements renamed port `listContracts` (signature),
  but KEEP the external `/internet-service` URL + any `SplynxService` external type
  (AD-5). It returns `Contract[]` now (the renamed entity).
- **KEEP:** `prisma/PrismaEmpresaRepository.ts` `prisma.servicePlan.*` (AD-4);
  `prisma/PrismaClosedServiceOrderRepository.ts` + iClass adapters (AD-8).

### 3.5 Infrastructure — HTTP (`src/infrastructure/http`)
- `routes/services.routes.ts` → `contracts.routes.ts`; `createServicesRouter` →
  `createContractsRouter`; routes `/services/stats` → `/contracts/stats`, `/services` →
  `/contracts`; params `listServices`/`getServiceStats` → `listContracts`/`getContractStats`;
  error strings "service stats" → "contract stats". (If the FE consumes a `/contracts/:id`
  detail route that origin lacks, do NOT add new behavior — the pinned `…/services/:id`
  → `…/contracts/:id` mapping covers the per-client stub + inventory `:contractId` param;
  there is no standalone `GET /api/services/:id` on origin today, so none is added.)
- `routes/serviceInventory.routes.ts` → `contractInventory.routes.ts`;
  `createServiceInventoryRouter` → `createContractInventoryRouter`; `:serviceId` →
  `:contractId` (×4 routes); `/services/:serviceId/inventory…` → `/contracts/:contractId/…`;
  `InventoryRoutePerms.serviceRead/serviceWrite` → `contractRead/contractWrite` (internal);
  `listByService`/`listInstalled.execute(serviceId)` calls follow the use-case rename;
  `addManual.execute({ serviceId })` → `contractId`. KEEP the `scheduling`-module task
  routes (`/scheduling/:taskId/...`) — those are task-scoped, not contract-scoped; only
  the contract-scoped group moves to `/contracts`.
- `routes/serviceTechnologies.routes.ts` → `contractTechnologies.routes.ts` — **confirm
  mount path during apply** (AD-3); if it is `/api/service-technologies` and the FE reads
  it, that URL moves lockstep too; record the decision in apply-progress.
- `routes/clients.routes.ts`: rename the in-memory stub block per AD-7 — `/:id/services`
  + `/:id/services/:serviceId` → `/:id/contracts` + `/:id/contracts/:contractId`; local
  `Service` interface → `Contract`; `servicesOverrideStore` → `contractsOverrideStore`;
  `nextServiceId` → `nextContractId`; `SERVICE_NOT_FOUND` → `CONTRACT_NOT_FOUND` (×2);
  `getServices` ctor param → `getContracts`; the real `/:id/services` (line 186 calling
  `getServices.execute`) → `/:id/contracts`. P2003 error prose "services" → "contracts".
- `routes/scheduling.routes.ts`: `REFERENCE_TO_CODE.service: 'SERVICE_NOT_FOUND'` (L47) →
  `contract: 'CONTRACT_NOT_FOUND'`; `serviceId: data.serviceId` (L317) → `contractId`.
- `app.ts` (wiring): `prismaClientLookup('Service'|...)` union + `case 'Service':
  prisma.service.findUnique` (L457-460) → `'Contract'` + `prisma.contract`; the two
  `prismaClientLookup('Service', id)` lookups (L607, L615 — these are the
  `serviceLookup` for CreateTask/UpdateTask) → `'Contract'`; `new ListServices` →
  `new ListContracts` (L662); `new GetServiceStats` → `new GetContractStats` (L663);
  `new GetClientServices` (L536) → `new GetClientContracts`; `createServicesRouter(...)`
  mount (L906) → `createContractsRouter`; the serviceInventory router construction +
  `serviceRead/serviceWrite` perm wiring → contract; all imports (L17, L143-145) follow
  file renames. Verify the inventory router's `requirePerm(module, action)` — origin uses
  `clients` module for contract routes (per the route-file comment); KEEP that RBAC module
  code (the RBAC module `code='contracts'` already exists — see §4).

### 3.6 Tests (`src/__tests__`) — rename to keep green (RENAME-ONLY)
All these MUST be updated to the new symbols/URLs so the suite stays green (strict TDD:
update tests FIRST in each apply batch). Non-exhaustive: `services.routes.test.ts` →
`contracts.routes.test.ts`; `serviceStats.routes.test.ts`; `ListServices.test.ts` →
`ListContracts.test.ts`; `GetServiceStats.test.ts`; `serviceInventory.routes.test.ts`;
`ServiceInventory.test.ts`; `serviceTechnologies.routes.test.ts`; `ServiceTechnology.test.ts`;
`schedulingServiceId.routes.test.ts` (→ `schedulingContractId…`); `CreateTask.test.ts`,
`UpdateTask.test.ts` (`serviceId`→`contractId`, `SERVICE_NOT_FOUND`→`CONTRACT_NOT_FOUND`);
`IngestGestionRealOrders.test.ts`; `clients.routes.test.ts`; `GetClientDetail.test.ts`;
`PrismaSchedulingRepository.toTask.test.ts`; `PrismaCustomerRepository.mappers.test.ts`;
`scheduling.dto.test.ts`. **KEEP** iClass `*ServiceOrder*` tests and `ServicePlan`/tarifas
tests untouched.

## 4. The migration — hand-written transactional ALTER…RENAME

**Why hand-written:** Prisma's auto-diff sees a model rename as DROP TABLE + CREATE TABLE
= total data loss in prod. `ALTER … RENAME` is metadata-only, instant, transactional,
preserves ALL rows/FKs/indexes. So we author the SQL by hand and tell Prisma the schema
already matches.

**Timestamp:** origin's latest migration is `20260601120000_iclass_closure_to_inventory`.
This rename must come AFTER it. **Chosen: `20260601130000_rename_service_to_contract`.**
(Leaves room: `tickets-actions-be` stacks ITS additive `ticketId` migration ON TOP at a
later timestamp, e.g. `20260602000000` — see §5.)

**Exact current object names (verified against migration history):**
| Object | Source migration |
|---|---|
| `Service` table, `Service_pkey`, `Service_clientId_fkey`, `Service_clientId_idx`, `Service_status_idx` | `20260514110000_add_client_module` |
| `Service_grContratoId_key` (unique) | `20260527000000_gestion_real_mirror` |
| `Service.technology` column | `20260530040000_service_technology` (additive ADD COLUMN — travels with table rename) |
| `Service.address/lat/lng` | `20260527070000_service_add_location` (travel with table) |
| `ScheduledTask_serviceId_fkey`, `ScheduledTask_serviceId_idx` (column `serviceId`) | `20260520020000_scheduling_tasks_enrich` |
| `ServiceTechnology` table, `ServiceTechnology_pkey`, `ServiceTechnology_name_key` | `20260530040000_service_technology` |
| `ServiceInstalledItem` table, `ServiceInstalledItem_pkey`, `ServiceInstalledItem_serviceId_idx`, `ServiceInstalledItem_serialNumber_idx`, `ServiceInstalledItem_serviceId_fkey` (column `serviceId`) | `20260601120000_iclass_closure_to_inventory` |

**Migration SQL (`prisma/migrations/20260601130000_rename_service_to_contract/migration.sql`):**
```sql
-- RENAME-ONLY, metadata-only, transactional. Preserves ALL data, FKs, indexes.
-- Renames: table Service->Contract, table ServiceTechnology->ContractTechnology,
-- table ServiceInstalledItem->ContractInstalledItem, column ScheduledTask.serviceId->contractId,
-- column ServiceInstalledItem.serviceId->contractId, + all dependent constraints/indexes.
BEGIN;

-- 1. Service -> Contract
ALTER TABLE "Service" RENAME TO "Contract";
ALTER TABLE "Contract" RENAME CONSTRAINT "Service_pkey"        TO "Contract_pkey";
ALTER TABLE "Contract" RENAME CONSTRAINT "Service_clientId_fkey" TO "Contract_clientId_fkey";
ALTER INDEX "Service_clientId_idx"     RENAME TO "Contract_clientId_idx";
ALTER INDEX "Service_status_idx"       RENAME TO "Contract_status_idx";
ALTER INDEX "Service_grContratoId_key" RENAME TO "Contract_grContratoId_key";
-- column "technology", "address","lat","lng" travel with the table (no statement needed).

-- 2. ScheduledTask.serviceId -> contractId
ALTER TABLE "ScheduledTask" RENAME COLUMN "serviceId" TO "contractId";
ALTER TABLE "ScheduledTask" RENAME CONSTRAINT "ScheduledTask_serviceId_fkey" TO "ScheduledTask_contractId_fkey";
ALTER INDEX "ScheduledTask_serviceId_idx" RENAME TO "ScheduledTask_contractId_idx";

-- 3. ServiceTechnology -> ContractTechnology
ALTER TABLE "ServiceTechnology" RENAME TO "ContractTechnology";
ALTER TABLE "ContractTechnology" RENAME CONSTRAINT "ServiceTechnology_pkey" TO "ContractTechnology_pkey";
ALTER INDEX "ServiceTechnology_name_key" RENAME TO "ContractTechnology_name_key";

-- 4. ServiceInstalledItem -> ContractInstalledItem (+ its serviceId column)
ALTER TABLE "ServiceInstalledItem" RENAME TO "ContractInstalledItem";
ALTER TABLE "ContractInstalledItem" RENAME COLUMN "serviceId" TO "contractId";
ALTER TABLE "ContractInstalledItem" RENAME CONSTRAINT "ServiceInstalledItem_pkey"         TO "ContractInstalledItem_pkey";
ALTER TABLE "ContractInstalledItem" RENAME CONSTRAINT "ServiceInstalledItem_serviceId_fkey" TO "ContractInstalledItem_contractId_fkey";
ALTER INDEX "ServiceInstalledItem_serviceId_idx"     RENAME TO "ContractInstalledItem_contractId_idx";
ALTER INDEX "ServiceInstalledItem_serialNumber_idx"  RENAME TO "ContractInstalledItem_serialNumber_idx";

COMMIT;
```

**`@@map` note:** `ServiceTechnology` had `@@map("ServiceTechnology")`. After rename to
`model ContractTechnology` with `@@map("ContractTechnology")`, the physical table is
`ContractTechnology` — matched by statement (3). `Service` and `ServiceInstalledItem` had
NO `@@map` (physical name == model name), so the table renames in (1)/(4) keep the schema
in sync without a `@@map`.

**RBAC module — NO migration change needed.** The `contracts` RBAC module
(`code='contracts'`, label 'Contratos', 4 perms, role grants) was seeded in
`20260530040000_service_technology`. It is already named "contracts" — the rename does
NOT touch it. The contract HTTP routes keep using their existing RBAC module code
(verify in app.ts whether they use `clients` or `contracts` module; either way, no DB
change). The `ServiceTechnology` SEED rows (Fiber/DOCSIS/… in that same migration) live
in the renamed `ContractTechnology` table after our rename — data preserved, no re-seed.

**Pre-push verification gate (no local DB needed):**
```
npx prisma migrate diff \
  --from-schema-datamodel /tmp/before.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --script
```
Where `/tmp/before.prisma` is origin's schema (pre-rename). Confirm the generated diff
ONLY proposes renames (or, in older Prisma, drop+create — that's expected; our HAND-WRITTEN
migration is the source of truth, NOT the diff). Then confirm the 13 target names exist
post-rename: `Contract`, `Contract_pkey`, `Contract_clientId_fkey`, `Contract_clientId_idx`,
`Contract_status_idx`, `Contract_grContratoId_key`, `ScheduledTask_contractId_fkey`,
`ScheduledTask_contractId_idx`, `ContractTechnology`, `ContractTechnology_pkey`,
`ContractTechnology_name_key`, `ContractInstalledItem` (+ its pkey/fkey/idx).
**REVIEW the SQL with the user before push.** A wrong RENAME name fails benignly
(transactional rollback, prod intact) but we want green on the first deploy.

**Rollback SQL (pre-stage, do not commit-run):** the exact inverse RENAMEs (Contract→Service,
contractId→serviceId, ContractTechnology→ServiceTechnology, ContractInstalledItem→
ServiceInstalledItem, and all constraint/index inverses), wrapped in BEGIN/COMMIT.

## 5. Lockstep deploy + migration ordering

### AD-DEPLOY — LOCKSTEP, no alias (BE + FE simultaneous)
There is NO alias / dual-route grace period. The instant BE deploys, `/api/services*`
stops existing and `/api/contracts*` begins. The FE must flip in the same window.

Pre-conditions (ALL true before pushing anything):
1. BOTH the BE change and the matching FE change are GREEN in CI on their branches.
2. Off-peak window agreed; the contracts tab is non-critical for a few minutes.
3. Migration SQL reviewed with the user; rollback SQL pre-staged.

Sequence:
1. Push BE → watch `gh` run GREEN (migration `migrate deploy` applied = table renamed).
2. IMMEDIATELY push FE → watch GREEN.
3. Smoke both: `GET /api/contracts`, `GET /api/contracts/stats`,
   `GET /api/clients/:id/contracts`, contract inventory, a `CreateTask` with `contractId`.

Breakage window = gap between BE-green and FE-live (minutes, off-peak). During it, the FE
still calling `/api/services*` gets 404 — acceptable for a non-critical tab in an off-peak
window. Rollback policy:
- BE deploy fails → migration's transaction rolled back, DB intact → do NOT push FE.
- BE green + FE fails → prefer ROLL-FORWARD (re-push FE). Last resort: revert BE +
  apply the pre-staged down-migration (inverse RENAMEs).

### AD-ORDER — ordering vs `tickets-actions-be`
`tickets-actions-be` adds an ADDITIVE `ticketId` FK to the SAME `ScheduledTask` table
(plus `Ticket.tasks` back-relation). Per engram #606 it had not yet generated its
migration on origin; it will stack on TOP of this rename.

- This change's migration: `20260601130000_rename_service_to_contract`.
- `tickets-actions-be`'s migration MUST be timestamped AFTER it (e.g.
  `20260602000000_task_add_ticket_fk`) and authored against the schema where
  `ScheduledTask` already has `contractId` (not `serviceId`).
- Deploy these two SEQUENTIALLY (one green in `gh` before starting the other), never
  interleaved, because they both mutate `ScheduledTask`. Recommended: deploy THIS rename
  first (it is the anchor), then `tickets-actions-be`.
- No content conflict: `ticketId` is purely additive and orthogonal to the
  `serviceId→contractId` column rename. The only coupling is migration order + the
  shared `ScheduledTask` model file (mechanical merge).

## 6. CreateTask required field (AD-REQUIRED)
Origin's `CreateTask` HARD-REQUIRES `serviceId` (`CreateTaskSchema.serviceId =
z.string().min(1)`, and the use-case throws `ReferenceNotFoundError('service', …)` when
the lookup misses). After this change that becomes a REQUIRED `contractId`:
`CreateTaskSchema.contractId = z.string().min(1)`, use-case throws
`ReferenceNotFoundError('contract', …)` → `CONTRACT_NOT_FOUND`. The required-ness is
PRESERVED (no functionality removed); only the field/error names change. The schema-level
column `ScheduledTask.contractId` stays nullable (origin's `serviceId String?`) — the
REQUIRED-ness is enforced at the DTO/use-case layer, not the DB, exactly as today.

## 7. Risks
- **Catalog endpoint URL (AD-3):** must confirm `serviceTechnologies.routes.ts` mount path
  and whether the FE consumes it under that name before deciding its lockstep URL move.
  Recorded as an apply-time confirmation, not a blocker.
- **`prisma as any` casts** in `PrismaServiceRepository`/`PrismaServiceTechnologyRepository`
  exist because the generated client lagged; after `prisma generate` on the renamed schema
  the typed `prisma.contract` accessor should let us drop the cast — but if the client is
  not regenerated in CI before tsc, keep a guarded cast. Verify the build pipeline runs
  `prisma generate` pre-`tsc`.
- **iClass "ServiceOrder" false positives:** the rename grep MUST exclude `*ServiceOrder*`,
  `getServiceOrders`, `ServicePlan`, Splynx `/internet-service`. Enumerated in AD-4/5/8.
