# Design: contract-services-model (#43)

BE-only, aditivo. Base: **origin/main @ 7a6505ae** (última migración `20260624000000_task_general_status`). Wire contract verbatim: ver `specs/*/spec.md` (los 3 specs pinean endpoints, bodies, shapes y error codes — el apply los implementa field-by-field).

## Architecture Decisions

| # | Decisión | Alternativa rechazada | Razón |
|---|---|---|---|
| 1 | Ports nuevos `ServiceCatalogRepository` + `ContractServiceRepository`; `ContractRepository` += `updateName()` | Extender `CustomerRepository` | Precedente DeviceTypeCatalog: catálogo = port propio. `name` vive en Contract → su port global. CustomerRepository queda solo-lectura de espejo |
| 2 | SIN `ServiceCatalogService` (caché) | Clonar `DeviceTypeCatalogService` | El caché de device-types valida nombres free-text (OCR). Acá hay FK real → integridad por DB. Router no llama `invalidate()` |
| 3 | 2 routers nuevos montados en `/api` root: `serviceCatalog.routes.ts` + `contractServices.routes.ts` | Meter PATCH en `contracts.routes.ts` o `clients.routes.ts` | `contracts.routes.ts` no recibe `requirePerm` (agregarlo cambiaría firma/behavior existente). El stub `contractsOverrideStore` (clients.routes.ts:353) queda INTACTO — deprecated, el FE #42 migra al endpoint nuevo. Sin conflicto catch-all: `/contracts/stats` y `/contracts` son GET; los nuevos son PATCH/POST/DELETE |
| 4 | Duplicado: pre-check `getByPair()` + adapter mapea P2002 → `ContractServiceDuplicateError` | Solo catch P2002 | In-memory parity trivial con pre-check; P2002 cubre la race |
| 5 | Existencia de contrato en `AddContractService` vía lookup inyectado `{ findById }` | Método en el port nuevo | Precedente exacto: `prismaClientLookup('Contract', id)` ya se inyecta así (app.ts:540, 707, 720) |
| 6 | `GET /api/contracts` global (ContractListItem) NO cambia | Agregar services al listado global | Fuera del wire contract; evita JOIN pesado paginado. #42 usa la tab por cliente |
| 7 | Error codes según specs: in-use → **422** `SERVICE_IN_USE`, OTROS → **422** `SERVICE_CATALOG_NON_DELETABLE` | 409 (precedente DeviceType) | Los specs (SC-4.2/4.3) ganan sobre el precedente; divergencia documentada |
| 8 | Relaciones Prisma: `Contract.contractServices`, `ContractService.serviceCatalog` | `services` | Pineado por spec CSV-4.4 (`include: { contractServices: { include: { serviceCatalog: true } } }`) |

## Schema diff (`prisma/schema.prisma`)

```prisma
model Contract {            // MODIFY
  name             String?           // manual-only; GR sync NUNCA lo escribe
  contractServices ContractService[]
}
model ServiceCatalog {      // NEW — clon DeviceTypeCatalog (schema:529-541)
  id String @id @default(uuid())
  name String @unique       // UPPERCASE canónico
  label String?
  active Boolean @default(true)
  sortOrder Int @default(0)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  contractServices ContractService[]
}
model ContractService {     // NEW — pivot
  id String @id @default(uuid())
  contractId String
  serviceCatalogId String
  status String @default("active")  // active | inactive
  notes String?
  createdAt DateTime @default(now())
  contract Contract @relation(fields: [contractId], references: [id], onDelete: Cascade)
  serviceCatalog ServiceCatalog @relation(fields: [serviceCatalogId], references: [id], onDelete: Restrict)
  @@unique([contractId, serviceCatalogId])
  @@index([contractId])
}
```

## Migraciones (SIN BEGIN/COMMIT — estilo 20260623000000)

1. `20260625000000_contract_name`: `ALTER TABLE "Contract" ADD COLUMN IF NOT EXISTS "name" TEXT;`
2. `20260626000000_service_catalog`: CREATE TABLE `ServiceCatalog` (DDL clon de `20260604050000_add_device_type_catalog`) + UNIQUE INDEX name + seed `INSERT ... VALUES (INTERNET,0)(TV,1)(VOZ,2)(CAMARAS,3)(OTROS,4) ON CONFLICT (name) DO NOTHING` + CREATE TABLE `ContractService` + FK contractId `ON DELETE CASCADE` + FK serviceCatalogId `ON DELETE RESTRICT` + UNIQUE `(contractId,serviceCatalogId)` + INDEX contractId.

## File Changes

| File | Action |
|---|---|
| `prisma/schema.prisma` + 2 migraciones | Modify/Create |
| `src/domain/entities/service-catalog.ts` (`ServiceCatalog`) · `contract-service.ts` (`ContractServiceView { id, contractId, serviceCatalogId, name, label, status, notes, createdAt }`) | Create |
| `src/domain/entities/customer.ts` — `Contract` += `name: string\|null`, `services: ContractServiceItem[]` (shape embebido SIN contractId, spec CSV-4.1) | Modify |
| `src/domain/ports/ServiceCatalogRepository.ts` — clon DeviceTypeCatalogRepository sin `listActiveNames`; `list(filter?: {active?: boolean})`, `getById`, `getByName`, `create`, `update`, `delete`, `countInUse(catalogId)` (cuenta ContractService por FK, no por name) | Create |
| `src/domain/ports/ContractServiceRepository.ts` — `getById`, `getByPair(contractId, serviceCatalogId)`, `add`, `update(id, {status?, notes?})`, `delete(id): Promise<boolean>` (todas devuelven `ContractServiceView` joineado) | Create |
| `src/domain/ports/ContractRepository.ts` — += `updateName(id, name: string\|null): Promise<{id, name}\|null>` | Modify |
| `src/domain/errors/contractServices.ts` — `ServiceCatalogNotFoundError(404)`, `ServiceCatalogNameConflictError(409)`, `ServiceCatalogInUseError(422 SERVICE_IN_USE)`, `ServiceCatalogProtectedError(422 SERVICE_CATALOG_NON_DELETABLE)`, `ServiceCatalogInactiveError(422)`, `ContractServiceDuplicateError(409 CONTRACT_SERVICE_DUPLICATE)`, `ContractServiceNotFoundError(404)`, `ContractNotFoundError(404 CONTRACT_NOT_FOUND — no existe en domain/errors, solo inline en routes)` | Create |
| `src/application/dto/contract-services.dto.ts` — zod: `CreateServiceCatalogSchema`/`Update...` (clon inventory.dto:3-9), `AddContractServiceSchema {serviceCatalogId: min(1), notes nullish}`, `UpdateContractServiceSchema {status enum opcional, notes nullish}`, `UpdateContractNameSchema {name: string nullable}` + DTOs | Create |
| Use cases: `ListServiceCatalog`, `CreateServiceCatalog` (normaliza UPPERCASE, clon CreateDeviceType), `UpdateServiceCatalog`, `DeleteServiceCatalog` (orden pineado: notFound → OTROS → in-use, clon DeleteDeviceType.ts:11), `AddContractService(csRepo, catalogRepo, contractLookup)` (404 contract → 404 catalog → 422 inactive → 409 dup), `UpdateContractService`, `RemoveContractService` (delete; 204 SIEMPRE — idempotente), `UpdateContractName(contractRepo)` (`'' → null` trim-normalize; null de updateName → ContractNotFoundError) | Create |
| `src/infrastructure/adapters/prisma/PrismaServiceCatalogRepository.ts` + `PrismaContractServiceRepository.ts` + in-memory parity (`InMemory...`, seam `itemCounts` como InMemoryDeviceTypeCatalogRepository) | Create |
| `src/infrastructure/adapters/prisma/PrismaContractRepository.ts` + `InMemoryContractRepository.ts` — `updateName` (Prisma: update catch P2025 → null) | Modify |
| `PrismaCustomerRepository.ts` — `listContracts` (línea ~195): `include: { contractServices: { include: { serviceCatalog: true }, orderBy: { createdAt: 'asc' } } }` (1 query, sin N+1); `toService` += `name: row.name ?? null`, `services: (row.contractServices ?? []).map(...)` (default `[]`) | Modify |
| `PrismaClientMirrorRepository.ts` — SOLO extender comentario GUARD (línea 91-94) mencionando `name`. El data object NO cambia | Modify |
| `src/infrastructure/http/routes/serviceCatalog.routes.ts` — `createServiceCatalogRouter(authProvider, requirePerm, list, create, update, del)`; paths `/service-catalog[/:id]`; GET→`('clients','read')` con filtro `?active=true`, POST/PATCH/DELETE→`('clients','manage')`. Clon estructural de deviceTypeCatalog.routes.ts (PATCH en vez de PUT, sin GET /:id, sin service.invalidate) | Create |
| `src/infrastructure/http/routes/contractServices.routes.ts` — `createContractServicesRouter(authProvider, requirePerm, updateContractName, addSvc, updateSvc, removeSvc)`; `PATCH /contracts/:id` + `POST/PATCH/DELETE /contracts/:contractId/services[/:id]`; todo `('clients','write')` | Create |
| `src/infrastructure/http/app.ts` — wiring después de línea 1023 (`createContractsRouter`): instanciar repos/UCs y `app.use('/api', createServiceCatalogRouter(...))` + `app.use('/api', createContractServicesRouter(...))`. `contractLookup` = `{ findById: (id) => prismaClientLookup('Contract', id) }` | Modify |

## Testing Strategy (Strict TDD — red primero)

| Test | Approach |
|---|---|
| `application/{Create,Update,Delete,List}ServiceCatalog.test.ts` + `{Add,Update,Remove}ContractService.test.ts` + `UpdateContractName.test.ts` | In-memory ports; guards: OTROS, in-use, inactive, dup, ''→null |
| `infrastructure/InMemory{ServiceCatalog,ContractService}Repository.test.ts` | Parity del port |
| `infrastructure/serviceCatalog.routes.test.ts` + `contractServices.routes.test.ts` | Supertest + in-memory; **seam tests (#28)**: status + body field-by-field por error code de los specs; 403 por permiso |
| `infrastructure/clients.contracts.shape.test.ts` | Regresión aditiva CSV-4.3: shape viejo intacto + `name`/`services: []` |
| `infrastructure/PrismaClientMirrorRepository.upsertData.test.ts` | **Data-block pinning (lección 2026-06-10)**: lee el source, extrae `const data = {` de `upsertContract`, asserts: keys exactas `{type, plan, status, startDate, address, lat, lng}`, contiene `address: k.address` (GR-wins pineado), NO contiene `name:` ni `technology:` |
| `infrastructure/contract-services-composition.test.ts` | Estático sobre app.ts (patrón task-general-status-composition.test.ts): (a) `/createServiceCatalogRouter\(/` con window que matchee `requirePerm`; (b) ídem `createContractServicesRouter`; (c) `/new UpdateContractName\([^)]*contractRepo/`; (d) `/app\.use\(\s*['"]\/api['"]\s*,\s*createServiceCatalogRouter/` y contractServices |
| `infrastructure/migration.service_catalog.test.ts` | Estático SQL (patrón migration.uisp_mirror.test.ts): ON CONFLICT (name) DO NOTHING, OTROS seedeado, CASCADE/RESTRICT correctos, **sin BEGIN/COMMIT** |

## Rollout

Deploy BE solo, sin flag — todo aditivo, el FE actual ignora campos nuevos. Seed corre en la migración → post-deploy: nada. Rollback: revert + DROP de las 2 tablas + DROP COLUMN name (proposal).

## Open Questions

Ninguna bloqueante.
