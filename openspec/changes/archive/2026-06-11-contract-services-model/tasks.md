# Tasks: contract-services-model (#43)

Wire contract verbatim: specs `contract-service-catalog/spec.md`, `contract-services/spec.md`, `contract-naming/spec.md` — el apply implementa endpoints, bodies, shapes y error codes field-by-field.
Branch: `feat/contract-services-model` from `origin/main`. Runner: `npx jest --runInBand`. BE-only.

---

## Phase 1: Schema + Migrations (Foundation)

- [x] 1.1 [RED] `migration.service_catalog.test.ts` — SQL estático: ON CONFLICT (name) DO NOTHING, OTROS seedeado, CASCADE/RESTRICT correctos, sin BEGIN/COMMIT (patrón migration.uisp_mirror.test.ts)
- [x] 1.2 [GREEN] `prisma/migrations/20260625000000_contract_name/migration.sql` — `ALTER TABLE "Contract" ADD COLUMN IF NOT EXISTS "name" TEXT;`
- [x] 1.3 [GREEN] `prisma/migrations/20260626000000_service_catalog/migration.sql` — CREATE TABLE ServiceCatalog + UNIQUE name + seed 5 entradas + CREATE TABLE ContractService + FK CASCADE/RESTRICT + UNIQUE (contractId,serviceCatalogId) + INDEX contractId
- [x] 1.4 [GREEN] `prisma/schema.prisma` — agregar `name String?` a `Contract`, modelos `ServiceCatalog` y `ContractService` (relaciones `contractServices` y `serviceCatalog` pineadas por spec CSV-4.4)

## Phase 2: Domain Layer

- [x] 2.1 `src/domain/entities/service-catalog.ts` — tipo `ServiceCatalog { id, name, label, active, sortOrder, createdAt, updatedAt }`
- [x] 2.2 `src/domain/entities/contract-service.ts` — tipo `ContractServiceView { id, contractId, serviceCatalogId, name, label, status, notes, createdAt }`
- [x] 2.3 `src/domain/entities/customer.ts` — `Contract` += `name: string|null`, `services: ContractServiceItem[]` (shape sin contractId, spec CSV-4.1)
- [x] 2.4 `src/domain/errors/contractServices.ts` — 8 errores tipados: `ServiceCatalogNotFoundError(404)`, `ServiceCatalogNameConflictError(409)`, `ServiceCatalogInUseError(422 SERVICE_IN_USE)`, `ServiceCatalogProtectedError(422 SERVICE_CATALOG_NON_DELETABLE)`, `ServiceCatalogInactiveError(422)`, `ContractServiceDuplicateError(409)`, `ContractServiceNotFoundError(404)`, `ContractNotFoundError(404)`
- [x] 2.5 `src/domain/ports/ServiceCatalogRepository.ts` — `list`, `getById`, `getByName`, `create`, `update`, `delete`, `countInUse(catalogId)`
- [x] 2.6 `src/domain/ports/ContractServiceRepository.ts` — `getById`, `getByPair`, `add`, `update(id, {status?,notes?})`, `delete(id): Promise<boolean>`
- [x] 2.7 `src/domain/ports/ContractRepository.ts` — += `updateName(id, name: string|null): Promise<{id,name}|null>`

## Phase 3: DTOs + Use Cases

- [x] 3.1 `src/application/dto/contract-services.dto.ts` — zod schemas: `CreateServiceCatalogSchema`, `UpdateServiceCatalogSchema`, `AddContractServiceSchema`, `UpdateContractServiceSchema`, `UpdateContractNameSchema` + tipos de salida
- [x] 3.2 [RED] `application/ListServiceCatalog.test.ts` + `CreateServiceCatalog.test.ts` — escenarios SC-1.1/1.2, SC-2.1/2.2; in-memory port
- [x] 3.3 [GREEN] `src/application/use-cases/ListServiceCatalog.ts` + `CreateServiceCatalog.ts` (normaliza UPPERCASE, clon CreateDeviceType)
- [x] 3.4 [RED] `application/UpdateServiceCatalog.test.ts` + `DeleteServiceCatalog.test.ts` — escenarios SC-3.1/3.2/3.3, SC-4.1/4.2/4.3/4.4; guards OTROS + in-use
- [x] 3.5 [GREEN] `src/application/use-cases/UpdateServiceCatalog.ts` + `DeleteServiceCatalog.ts` (orden: notFound → OTROS → in-use, clon DeleteDeviceType.ts:11)
- [x] 3.6 [RED] `application/AddContractService.test.ts` — escenarios CSV-1.1–1.5; guards 404-contract → 404-catalog → 422-inactive → 409-dup
- [x] 3.7 [GREEN] `src/application/use-cases/AddContractService.ts` (csRepo + catalogRepo + contractLookup `{ findById }`)
- [x] 3.8 [RED] `application/UpdateContractService.test.ts` + `RemoveContractService.test.ts` — escenarios CSV-2.1–2.4, CSV-3.1/3.2; 204 idempotente
- [x] 3.9 [GREEN] `src/application/use-cases/UpdateContractService.ts` + `RemoveContractService.ts`
- [x] 3.10 [RED] `application/UpdateContractName.test.ts` — escenarios CN-2.1/2.2/2.3; `''` → null trim-normalize
- [x] 3.11 [GREEN] `src/application/use-cases/UpdateContractName.ts` (null de updateName → ContractNotFoundError)

## Phase 4: Adapters

- [x] 4.1 [RED] `infrastructure/InMemoryServiceCatalogRepository.test.ts` — parity port completo; seam `itemCounts` (patrón InMemoryDeviceTypeCatalogRepository)
- [x] 4.2 [GREEN] `src/infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository.ts`
- [x] 4.3 [RED] `infrastructure/InMemoryContractServiceRepository.test.ts` — parity port completo
- [x] 4.4 [GREEN] `src/infrastructure/adapters/in-memory/InMemoryContractServiceRepository.ts`
- [x] 4.5 [GREEN] `src/infrastructure/adapters/prisma/PrismaServiceCatalogRepository.ts` (clon PrismaDeviceTypeCatalogRepository)
- [x] 4.6 [GREEN] `src/infrastructure/adapters/prisma/PrismaContractServiceRepository.ts` — joins `serviceCatalog`; pre-check `getByPair` + mapeo P2002 → `ContractServiceDuplicateError`
- [x] 4.7 `src/infrastructure/adapters/prisma/PrismaContractRepository.ts` + `InMemoryContractRepository.ts` — += `updateName` (Prisma: catch P2025 → null)
- [x] 4.8 `src/infrastructure/adapters/prisma/PrismaCustomerRepository.ts` — `listContracts` ~línea 195: agregar `include: { contractServices: { include: { serviceCatalog: true }, orderBy: { createdAt: 'asc' } } }`; mapper `toService` += `name: row.name ?? null`, `services: (row.contractServices ?? []).map(...)`
- [x] 4.9 `src/infrastructure/adapters/prisma/PrismaClientMirrorRepository.ts` — extender comentario GUARD línea 91-94 mencionando `name`; NO cambiar el data object

## Phase 5: Routes + Wiring

- [x] 5.1 `src/infrastructure/http/routes/serviceCatalog.routes.ts` — `createServiceCatalogRouter`; paths `/service-catalog[/:id]`; GET→`clients.read`, POST/PATCH/DELETE→`clients.manage`; clon deviceTypeCatalog.routes.ts (PATCH no PUT, sin GET /:id, sin service.invalidate)
- [x] 5.2 `src/infrastructure/http/routes/contractServices.routes.ts` — `createContractServicesRouter`; `PATCH /contracts/:id` + `POST/PATCH/DELETE /contracts/:contractId/services[/:id]`; todo `clients.write`
- [x] 5.3 `src/infrastructure/http/app.ts` — wiring post línea 1023: instanciar repos/UCs, `app.use('/api', createServiceCatalogRouter(...))` + `app.use('/api', createContractServicesRouter(...))`, `contractLookup = { findById: (id) => prismaClientLookup('Contract', id) }`

## Phase 6: Tests de Integración + Regresión

- [x] 6.1 [RED] `infrastructure/serviceCatalog.routes.test.ts` — seam tests (#28): supertest + in-memory; status + body field-by-field por scenario SC-1.1–SC-4.4; 403 por permiso
- [x] 6.2 [GREEN] hacer pasar 6.1
- [x] 6.3 [RED] `infrastructure/contractServices.routes.test.ts` — seam tests (#28): CSV-1.1–CSV-3.2; 403; CN-2.1–CN-2.4
- [x] 6.4 [GREEN] hacer pasar 6.3
- [x] 6.5 [RED] `infrastructure/clients.contracts.shape.test.ts` — regresión aditiva CSV-4.3: shape viejo intacto + `name: null` + `services: []`
- [x] 6.6 [GREEN] hacer pasar 6.5
- [x] 6.7 `infrastructure/PrismaClientMirrorRepository.upsertData.test.ts` — data-block pinning: leer source, extraer `const data = {` de `upsertContract`, assert keys exactas `{type,plan,status,startDate,address,lat,lng}`, NO contiene `name:` ni `technology:`
- [x] 6.8 `infrastructure/contract-services-composition.test.ts` — estático sobre app.ts: (a) `/createServiceCatalogRouter\(/` con window `requirePerm`; (b) ídem `createContractServicesRouter`; (c) `/new UpdateContractName\([^)]*contractRepo/`; (d) `/app\.use\(\s*['"]\/api['"]\s*,\s*createServiceCatalogRouter/` y contractServices

## Phase 7: Gates del Orquestador

- [x] 7.1 `npx jest --runInBand` — todos los tests pasan (0 failing)
- [x] 7.2 `npx tsc --noEmit` — 0 errores de tipado
