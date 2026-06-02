# Tasks — `contratos-naming-be` (Service → Contract, anchor)

> RENAME-ONLY. Zero functionality removed. Strict TDD: in each batch, update the
> affected tests FIRST (red against new names), then rename production code (green).
> Base: origin/main 0bddf7d1. Migration timestamp: `20260601130000_rename_service_to_contract`.

## Batch 1 — Schema + migration (foundation)
- [ ] 1.1 Rename in `prisma/schema.prisma`: `model Service`→`Contract` (+ `Client.services`→`contracts`); `ScheduledTask.serviceId/service`→`contractId/contract` + index; `ServiceInstalledItem`→`ContractInstalledItem` (+ `serviceId`→`contractId` + indexes + `Contract.installedItems` type); `ServiceTechnology`→`ContractTechnology` (+ `@@map`); fix comment prose.
- [ ] 1.2 KEEP untouched: `ServicePlan`, all `IClass*ServiceOrder*`/`IClassSoType`.
- [ ] 1.3 Author `prisma/migrations/20260601130000_rename_service_to_contract/migration.sql` — the hand-written transactional ALTER…RENAME from design §4 (table Service→Contract + ScheduledTask.serviceId→contractId + ServiceTechnology→ContractTechnology + ServiceInstalledItem→ContractInstalledItem, all constraints/indexes).
- [ ] 1.4 Run `npx prisma migrate diff --from-schema-datamodel <origin-schema> --to-schema-datamodel prisma/schema.prisma --script` and confirm the 13 target names. DO NOT auto-generate the migration (Prisma would DROP+CREATE).
- [ ] 1.5 `prisma generate` so `prisma.contract` / `prisma.contractInstalledItem` / `prisma.contractTechnology` accessors exist for the typed adapters.
- [ ] 1.6 Pre-stage rollback SQL (inverse RENAMEs) in the design/notes — not committed as a migration.

## Batch 2 — Domain layer
- [ ] 2.1 Tests: rename domain-error expectations (`ReferenceKind 'service'`→`'contract'`) in `scheduling.test.ts`.
- [ ] 2.2 `entities/customer.ts`: `interface Service`→`Contract`.
- [ ] 2.3 `entities/service-installed-item.ts`→`contract-installed-item.ts`; type + `serviceId`→`contractId`.
- [ ] 2.4 `entities/serviceTechnology.ts`→`contractTechnology.ts`.
- [ ] 2.5 `ports/ServiceRepository.ts`→`ContractRepository.ts` (+ `ServiceListItem`/`ListServicesQuery`/`ServiceStats`→`Contract*`).
- [ ] 2.6 `ports/ServiceInventoryRepository.ts`→`ContractInventoryRepository.ts`; `listByService`→`listByContract`.
- [ ] 2.7 `ports/ServiceTechnologyRepository.ts`→`ContractTechnologyRepository.ts`.
- [ ] 2.8 `ports/CustomerRepository.ts`: `listServices`→`listContracts`; import `Contract`.
- [ ] 2.9 `ports/GrLinkResolverPort.ts`: `findServiceByGrContratoId`→`findContractByGrContratoId`.
- [ ] 2.10 `errors/scheduling.ts`: `ReferenceKind 'service'`→`'contract'`.
- [ ] 2.11 `errors/serviceTechnology.ts`→`contractTechnology.ts`.
- [ ] 2.12 KEEP `ports/ClosedServiceOrderRepository.ts` (iClass SO).

## Batch 3 — Application layer
- [ ] 3.1 Tests first: `ListServices.test.ts`→`ListContracts.test.ts`, `GetServiceStats.test.ts`, `ServiceInventory.test.ts`, `ServiceTechnology.test.ts`, `CreateTask.test.ts`, `UpdateTask.test.ts`, `IngestGestionRealOrders.test.ts`, `scheduling.dto.test.ts`, `GetClientDetail.test.ts` (`serviceId`→`contractId`, `SERVICE_NOT_FOUND`→`CONTRACT_NOT_FOUND`, `listByService`→`listByContract`).
- [ ] 3.2 `use-cases/ListServices.ts`→`ListContracts.ts`.
- [ ] 3.3 `use-cases/GetServiceStats.ts`→`GetContractStats.ts`.
- [ ] 3.4 `use-cases/GetClientServices.ts`→`GetClientContracts.ts` (`repo.listContracts`).
- [ ] 3.5 `use-cases/ListServiceInstalledItems.ts`→`ListContractInstalledItems.ts` (`listByContract`, param `contractId`).
- [ ] 3.6 `use-cases/AddInstalledItemManually.ts`: input `serviceId`→`contractId`.
- [ ] 3.7 `use-cases/ConfirmInventorySuggestion.ts`: `task.contractId`, `TaskHasNoServiceError`→`TaskHasNoContractError`, item `contractId`.
- [ ] 3.8 `use-cases/CreateTask.ts`: `serviceLookup`→`contractLookup`, `data.contractId`, `ReferenceNotFoundError('contract', …)`.
- [ ] 3.9 `use-cases/UpdateTask.ts`: same as 3.8.
- [ ] 3.10 `use-cases/*ServiceTechnology.ts` (Create/Get/List/Update/Delete) → `*ContractTechnology.ts`.
- [ ] 3.11 `use-cases/IngestGestionRealOrders.ts`: `findContractByGrContratoId`, `contract` var, payload `contractId: contract.id`.
- [ ] 3.12 `dto/scheduling.dto.ts`: `serviceId`→`contractId` (base + CreateTaskSchema required) + prose.
- [ ] 3.13 `dto/gestionRealIngest.dto.ts`: `serviceId`→`contractId` (field + mapping).
- [ ] 3.14 `dto/serviceTechnology.dto.ts`→`contractTechnology.dto.ts`.
- [ ] 3.15 KEEP `dto/contract.dto.ts` (already correct); KEEP `ServicePlan*` use-cases, `*ClosedServiceOrders`, `SyncGestionRealContracts`.

## Batch 4 — Infrastructure adapters
- [ ] 4.1 Tests first: `PrismaSchedulingRepository.toTask.test.ts`, `PrismaCustomerRepository.mappers.test.ts`, `InMemoryGrLinkResolver.test.ts` (rename symbols/fields).
- [ ] 4.2 `prisma/PrismaServiceRepository.ts`→`PrismaContractRepository.ts`; `prisma.contract` (drop `as any` if client typed).
- [ ] 4.3 `prisma/PrismaServiceInventoryRepository.ts`→`PrismaContractInventoryRepository.ts`; `prisma.contractInstalledItem`; `contractId`; `listByContract`.
- [ ] 4.4 `prisma/PrismaServiceTechnologyRepository.ts`→`PrismaContractTechnologyRepository.ts`; `prisma.contract.count`.
- [ ] 4.5 `prisma/PrismaCustomerRepository.ts`: `listContracts`; `prisma.contract.findMany`.
- [ ] 4.6 `prisma/PrismaClientMirrorRepository.ts`: `prisma.contract.*` (×3).
- [ ] 4.7 `prisma/PrismaGrLinkResolver.ts`: method rename; `prisma.contract.findUnique`; `contract` var.
- [ ] 4.8 `prisma/PrismaMirrorCountsRepository.ts`: `prisma.contract.count`.
- [ ] 4.9 `prisma/PrismaSchedulingRepository.ts`: `serviceId`→`contractId` (L80,455,491) + relation `service`→`contract` in toTask include/select.
- [ ] 4.10 `in-memory/InMemoryServiceRepository.ts`→`InMemoryContractRepository.ts`.
- [ ] 4.11 `in-memory/InMemoryServiceInventoryRepository.ts`→`InMemoryContractInventoryRepository.ts` (`listByContract`, `contractId`).
- [ ] 4.12 `in-memory/InMemoryServiceTechnologyRepository.ts`→`InMemoryContractTechnologyRepository.ts`.
- [ ] 4.13 `in-memory/InMemorySchedulingRepository.ts`: `serviceId`→`contractId` (L60,268,317).
- [ ] 4.14 `in-memory/InMemoryGrLinkResolver.ts`: method rename.
- [ ] 4.15 `splynx/SplynxCustomerAdapter.ts`: impl `listContracts` returning `Contract[]`; KEEP external `/internet-service` URL + `SplynxService` external type.
- [ ] 4.16 KEEP `PrismaEmpresaRepository.ts` `prisma.servicePlan.*`; KEEP iClass/ClosedServiceOrder adapters.

## Batch 5 — HTTP layer + wiring (the wire)
- [ ] 5.1 Tests first: `services.routes.test.ts`→`contracts.routes.test.ts`, `serviceStats.routes.test.ts`, `serviceInventory.routes.test.ts`, `serviceTechnologies.routes.test.ts`, `schedulingServiceId.routes.test.ts`→`schedulingContractId`, `clients.routes.test.ts` (URLs `/services`→`/contracts`, params `:serviceId`→`:contractId`, codes).
- [ ] 5.2 `routes/services.routes.ts`→`contracts.routes.ts`; `createContractsRouter`; `/contracts/stats`+`/contracts`; params `listContracts`/`getContractStats`.
- [ ] 5.3 `routes/serviceInventory.routes.ts`→`contractInventory.routes.ts`; `:serviceId`→`:contractId`; `/services/:…`→`/contracts/:…`; perms `contractRead/contractWrite`; KEEP `/scheduling/:taskId/...` task routes.
- [ ] 5.4 `routes/serviceTechnologies.routes.ts`→`contractTechnologies.routes.ts` — **confirm mount path + FE consumption first**; record decision in apply-progress.
- [ ] 5.5 `routes/clients.routes.ts`: stub block `/:id/services*`→`/:id/contracts*`; local `Service`→`Contract`; `servicesOverrideStore`→`contractsOverrideStore`; `nextServiceId`→`nextContractId`; `SERVICE_NOT_FOUND`→`CONTRACT_NOT_FOUND` (×2); ctor `getServices`→`getContracts`; real `/:id/services`→`/:id/contracts`; P2003 prose.
- [ ] 5.6 `routes/scheduling.routes.ts`: `REFERENCE_TO_CODE.contract:'CONTRACT_NOT_FOUND'`; `contractId: data.contractId` (L317).
- [ ] 5.7 `app.ts`: `prismaClientLookup` union `'Service'`→`'Contract'` + `prisma.contract.findUnique`; both contract lookups (L607,615); `new ListContracts`/`new GetContractStats`/`new GetClientContracts`; `createContractsRouter` mount; contract-inventory router + perms; all imports follow file renames. Verify `prisma generate` runs pre-`tsc` in CI.

## Batch 6 — Verify, smoke, deploy gate
- [ ] 6.1 Full `npm test` green.
- [ ] 6.2 Grep the tree for stray `serviceId`, `/services`, `SERVICE_NOT_FOUND`, `prisma.service` (excluding `ServicePlan`, `*ServiceOrder*`, Splynx `/internet-service`).
- [ ] 6.3 Run the `prisma migrate diff` verification gate (design §4); confirm 13 target names.
- [ ] 6.4 REVIEW migration SQL with the user. Pre-stage rollback SQL.
- [ ] 6.5 Confirm `tickets-actions-be` will re-timestamp its migration AFTER `20260601130000` and rebuild against `ScheduledTask.contractId`. Coordinate sequential (non-interleaved) deploy.
- [ ] 6.6 LOCKSTEP deploy per design §5 (BE+FE both green → push BE → green → push FE → smoke).
