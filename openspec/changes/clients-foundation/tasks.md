# Tasks: clients-foundation

## Phase 0 — Test DB setup y dependencias
> Checkpoint: `npx tsc --noEmit` y `npm test` pasan. DB de test lista.

- [ ] 0.1 Instalar `zod`: `npm install zod` — `package.json` (Modify) — 5m — no deps
- [ ] 0.2 Crear `docker-compose.test.yml` con servicio Postgres puerto 5433, DB `ipnext_test` — `docker-compose.test.yml` (Create) — 10m — no deps
- [ ] 0.3 Agregar `DATABASE_URL_TEST` a `env.example` (NO secret real) — `env.example` (Modify) — 5m — dep 0.2
- [ ] 0.4 Crear `src/infrastructure/database/prisma.test.ts` que exporte `prismaTest` con `DATABASE_URL_TEST` — `src/infrastructure/database/prisma.test.ts` (Create) — 10m — dep 0.3
- [ ] 0.5 Crear `src/__tests__/jest.setup.ts`: `beforeEach` truncate tablas vía `prismaTest.$executeRawUnsafe`, `afterAll` `prismaTest.$disconnect()` — `src/__tests__/jest.setup.ts` (Create) — 20m — dep 0.4
- [ ] 0.6 Actualizar `jest.config.js`: agregar `setupFilesAfterFramework: ['<rootDir>/__tests__/jest.setup.ts']` y `testTimeout: 30000` — `jest.config.js` (Modify) — 5m — dep 0.5
- [ ] 0.7 Agregar scripts a `package.json`: `test:db:up`, `test:db:down`, `test:db:reset` — `package.json` (Modify) — 5m — dep 0.2
- [ ] 0.8 Levantar DB test (`npm run test:db:up`), aplicar schema (`DATABASE_URL_TEST=... npx prisma migrate deploy`), verificar baseline `npm test` sin regresión — (verificación) — 10m — dep 0.6

---

## Phase 1 — Commit 1: Schema + migration + seed
> Gate: `prisma migrate dev` sin error + `prisma db seed` idempotente + `tsc --noEmit`
> Commit: `feat(prisma): add Client model, ClientType and Segment catalogs with seed`

- [ ] 1.1 Editar `prisma/schema.prisma`: agregar `enum ClientStatus { active late blocked inactive }` — `prisma/schema.prisma` (Modify) — 10m — dep Phase 0
- [ ] 1.2 Agregar `model ClientType { id String @id @default(uuid()) name String @unique slug String @unique createdAt/updatedAt clients Client[] }` — `prisma/schema.prisma` (Modify) — 5m — dep 1.1
- [ ] 1.3 Agregar `model Segment { id String @id @default(uuid()) name String @unique slug String @unique createdAt/updatedAt clients Client[] }` — `prisma/schema.prisma` (Modify) — 5m — dep 1.2
- [ ] 1.4 Agregar `model Client { id UUID PK, splynxId? @unique, name, email @unique, login @unique, phone?, address?, city?, country?, status ClientStatus @default(active), customAttributes Json?, partnerId? FK, ubicacionId? FK, clientTypeId? FK, segmentId? FK, createdAt, updatedAt, @@index([status,partnerId,segmentId,clientTypeId,ubicacionId,splynxId]) }` — `prisma/schema.prisma` (Modify) — 15m — dep 1.3
- [ ] 1.5 Agregar relaciones inversas en modelos `Partner` y `Ubicacion` si no existen — `prisma/schema.prisma` (Modify) — 5m — dep 1.4
- [ ] 1.6 Generar migration: `npx prisma migrate dev --name add_client_model_and_catalogs` — (comando) — 5m — dep 1.5
- [ ] 1.7 Revisar `prisma/migrations/<ts>_add_client_model_and_catalogs/migration.sql`: verificar enum, tablas, FKs, índices presentes — (verificación) — 5m — dep 1.6
- [ ] 1.8 Crear/extender `prisma/seed.ts`: `upsert` por slug para 3 ClientType (persona/empresa/reseller) y 3 Segment (residencial/pyme/corporativo) — `prisma/seed.ts` (Modify) — 15m — dep 1.6
- [ ] 1.9 Verificar idempotencia: `npx prisma db seed && npx prisma db seed` → mismo conteo, sin duplicados — (verificación) — 5m — dep 1.8
- [ ] 1.10 Aplicar migration a DB test: `DATABASE_URL_TEST=... npx prisma migrate deploy` — (comando) — 5m — dep 1.6
- [ ] 1.11 `npx tsc --noEmit` → 0 errores. `npm test` → suite existente verde — (verificación) — 5m — dep 1.9
- [ ] 1.12 Commit: `feat(prisma): add Client model, ClientType and Segment catalogs with seed` — (git) — 2m — dep 1.11

---

## Phase 2 — Commit 2: Domain + Application (TDD)
> Gate: tests use cases verdes + suite existente verde + `tsc --noEmit`
> Commit: `feat(domain,application): add Client CRUD use cases and write port methods`

- [ ] 2.1 Agregar `EmailAlreadyExistsError`, `LoginAlreadyExistsError`, `SplynxIdImmutableError` a `src/domain/errors/index.ts` (Modify) — 10m — dep Phase 1
- [ ] 2.2 Extender `src/domain/entities/customer.ts`: agregar campos `splynxId?`, `clientTypeId?`, `segmentId?`, `partnerId?`, `ubicacionId?` a interface `Customer` — (Modify) — 10m — dep 2.1
- [ ] 2.3 Extender `src/domain/ports/CustomerRepository.ts`: agregar tipos `ClientStatus`, `CreateClientInput`, `UpdateClientInput` (sin `splynxId`), y métodos `create/update/delete/changeStatus` — (Modify) — 15m — dep 2.2
- [ ] 2.4 Crear `src/domain/ports/ClientTypeRepository.ts`: `interface ClientTypeRepository { list(): Promise<ClientType[]> }` — (Create) — 5m — dep 2.3
- [ ] 2.5 Crear `src/domain/ports/SegmentRepository.ts`: `interface SegmentRepository { list(): Promise<Segment[]> }` — (Create) — 5m — dep 2.4
- [ ] 2.6 **TDD RED**: crear `src/__tests__/application/CreateClient.test.ts` con test failing (mockea `CustomerRepository`) — `src/__tests__/application/CreateClient.test.ts` (Create) — 15m — dep 2.3. Requiere test previo.
- [ ] 2.7 **TDD GREEN**: crear `src/application/use-cases/CreateClient.ts` hasta que 2.6 pase — `src/application/use-cases/CreateClient.ts` (Create) — 15m — dep 2.6
- [ ] 2.8 **TDD RED**: crear `src/__tests__/application/UpdateClient.test.ts` — incluye test `splynxId` inmutable — (Create) — 15m — dep 2.7. Requiere test previo.
- [ ] 2.9 **TDD GREEN**: crear `src/application/use-cases/UpdateClient.ts` — (Create) — 15m — dep 2.8
- [ ] 2.10 **TDD RED**: crear `src/__tests__/application/DeleteClient.test.ts` — borra incondicional (con TODO) — (Create) — 10m — dep 2.9. Requiere test previo.
- [ ] 2.11 **TDD GREEN**: crear `src/application/use-cases/DeleteClient.ts` — (Create) — 10m — dep 2.10
- [ ] 2.12 **TDD RED**: crear `src/__tests__/application/ChangeClientStatus.test.ts` — (Create) — 10m — dep 2.11. Requiere test previo.
- [ ] 2.13 **TDD GREEN**: crear `src/application/use-cases/ChangeClientStatus.ts` — (Create) — 10m — dep 2.12
- [ ] 2.14 **TDD RED**: crear `src/__tests__/application/GetClientCatalogs.test.ts` — (Create) — 10m — dep 2.13. Requiere test previo.
- [ ] 2.15 **TDD GREEN**: crear `src/application/use-cases/GetClientCatalogs.ts` con `Promise.all([clientTypeRepo.list(), segmentRepo.list()])` + statuses hardcoded — (Create) — 10m — dep 2.14
- [ ] 2.16 Verificar invariante I-1: `rg "from '@infrastructure" src/application/use-cases/` → 0 — (verificación) — 2m — dep 2.15
- [ ] 2.17 `npx tsc --noEmit` → 0 errores. `npm test` → todos verdes — (verificación) — 5m — dep 2.16
- [ ] 2.18 Commit: `feat(domain,application): add Client CRUD use cases and write port methods` — (git) — 2m — dep 2.17

---

## Phase 3 — Commit 3: Infrastructure (PrismaClientRepository + zod + validate)
> Gate: tests contract repo verdes con DB test + tests unit zod verdes + `tsc --noEmit`
> Commit: `feat(infrastructure): add PrismaClientRepository, zod schemas and validate middleware`

- [ ] 3.1 Crear `src/infrastructure/adapters/prisma/mappers/clientMapper.ts`: `toDomain(row): Customer`, `toCreateInput(input)` — (Create) — 15m — dep Phase 2. Requiere test previo.
- [ ] 3.2 **TDD RED**: crear `src/__tests__/infrastructure/PrismaClientRepository.contract.test.ts` — usa `prismaTest`, verifica `create/update/delete/changeStatus/listServices/listInvoices/listLogs` — (Create) — 30m — dep 3.1. Requiere test previo.
- [ ] 3.3 **TDD GREEN**: crear `src/infrastructure/adapters/prisma/PrismaClientRepository.ts` — implementa `CustomerRepository`, `listServices/listInvoices/listLogs` retornan `[]` con `// TODO: implement in clients-data-migration`, `P2002` → `EmailAlreadyExistsError`/`LoginAlreadyExistsError`, `P2025` → `ClientNotFoundError` — (Create) — 45m — dep 3.2
- [ ] 3.4 Crear `src/infrastructure/adapters/prisma/PrismaClientTypeRepository.ts`: implementa `ClientTypeRepository.list()` via `prisma.clientType.findMany({ orderBy: { name: 'asc' } })` — (Create) — 10m — dep 3.3
- [ ] 3.5 Crear `src/infrastructure/adapters/prisma/PrismaSegmentRepository.ts`: implementa `SegmentRepository.list()` — (Create) — 10m — dep 3.4
- [ ] 3.6 Crear `src/infrastructure/http/schemas/client.schemas.ts`: `createClientSchema`, `updateClientSchema` (sin `splynxId`), `listClientsQuerySchema`, `changeClientStatusSchema` — (Create) — 20m — dep 3.3
- [ ] 3.7 Crear `src/infrastructure/http/middleware/validate.ts`: middleware genérico `validate(schema: ZodSchema)` que retorna 400 con detalles zod si falla — (Create) — 10m — dep 3.6
- [ ] 3.8 Verificar invariante I-2: `rg "from 'zod'" src/domain/` → 0 — (verificación) — 2m — dep 3.7
- [ ] 3.9 `npx tsc --noEmit` → 0 errores. `npm test` (con DB test corriendo) → todos verdes — (verificación) — 5m — dep 3.8
- [ ] 3.10 Commit: `feat(infrastructure): add PrismaClientRepository, zod schemas and validate middleware` — (git) — 2m — dep 3.9

---

## Phase 4 — Commit 4: HTTP — routes + catalogs + wiring
> Gate: suite completa verde incluyendo tests integración cliente + `tsc --noEmit`
> Commit: `feat(http): wire Client CRUD endpoints and catalogs aggregator`

- [ ] 4.1 Crear `src/infrastructure/http/routes/clientCatalogs.routes.ts`: `GET /api/clients/catalogs` con `GetClientCatalogs` use case — (Create) — 15m — dep Phase 3. Requiere test previo.
- [ ] 4.2 **TDD RED**: crear `src/__tests__/clients.routes.test.ts` (o extender existente): POST/PATCH/DELETE/PATCH-status + GET /catalogs + GET list + GET detail — verifica 201/200/204/404/409/400 según spec — (Create/Modify) — 40m — dep 4.1. Requiere test previo.
- [ ] 4.3 **TDD GREEN**: refactorizar `src/infrastructure/http/routes/clients.routes.ts` — `POST` → `CreateClient` con `validate(createClientSchema)`, `PATCH /:id` → `UpdateClient`, `DELETE /:id` → `DeleteClient`, `PATCH /:id/status` → `ChangeClientStatus`, `GET /` → `ListClients` (PrismaClientRepository), `GET /:id` → `GetClientDetail` (PrismaClientRepository) — (Modify) — 40m — dep 4.2
- [ ] 4.4 Actualizar `src/infrastructure/http/app.ts`: eliminar `import SplynxCustomerAdapter`, eliminar `customerAdapter = new SplynxCustomerAdapter(...)`, agregar bloque `// === Clients ===` con `PrismaClientRepository`, `PrismaClientTypeRepository`, `PrismaSegmentRepository`, instanciar los 5 use cases existentes + 5 nuevos + `GetClientCatalogs`, registrar `clientCatalogsRouter` ANTES de `clientsRouter` — (Modify) — 30m — dep 4.3
- [ ] 4.5 Verificar: `rg "SplynxCustomerAdapter" src/infrastructure/http/app.ts` → 0 — (verificación) — 2m — dep 4.4
- [ ] 4.6 Verificar: `GET /api/clients/catalogs` registrado antes de `GET /api/clients/:id` en el orden de rutas de `app.ts` — (verificación) — 2m — dep 4.4
- [ ] 4.7 `npx tsc --noEmit` → 0 errores. `npm test` → suite completa verde (≥ 322 + nuevos) — (verificación) — 10m — dep 4.6
- [ ] 4.8 Commit: `feat(http): wire Client CRUD endpoints and catalogs aggregator` — (git) — 2m — dep 4.7

---

## Phase 5 — Commit 5: Remove sharedClientStore
> Gate: suite completa verde + `tsc --noEmit`
> Commit: `refactor(dashboard): remove sharedClientStore in-memory client counters`

- [ ] 5.1 Editar `src/infrastructure/adapters/in-memory/InMemoryDashboardRepository.ts`: eliminar `import { sharedClientStore }`, reemplazar `sharedClientStore.newThisMonth` y `sharedClientStore.activeCount` por valores fijos (0 o los valores hardcoded del dashboard) — (Modify) — 15m — dep Phase 4
- [ ] 5.2 Editar `src/infrastructure/adapters/in-memory/shared-stores.ts`: eliminar `sharedClientStore`, eliminar funciones `addClient`/`removeClient` — (Modify) — 10m — dep 5.1
- [ ] 5.3 Verificar: `rg "sharedClientStore" src/` → 0 — (verificación) — 2m — dep 5.2
- [ ] 5.4 `npx tsc --noEmit` → 0 errores. `npm test` → suite completa verde — (verificación) — 5m — dep 5.3
- [ ] 5.5 Commit: `refactor(dashboard): remove sharedClientStore in-memory client counters` — (git) — 2m — dep 5.4

---

## Phase 6 — Verificación final
> No genera commit. Gates de cierre del cambio.

- [ ] 6.1 `rg "from '@infrastructure" src/application/use-cases/"` → 0 (DIP limpio) — 2m
- [ ] 6.2 `rg "from 'zod'" src/domain/"` → 0 (zod fuera del dominio) — 2m
- [ ] 6.3 `rg "splynxAdapter\|SplynxCustomerAdapter" src/infrastructure/http/app.ts` → 0 — 2m
- [ ] 6.4 `rg "sharedClientStore" src/"` → 0 — 2m
- [ ] 6.5 `npm run prisma:migrate` y `npm run prisma:seed` corren sin error en entorno local — 5m
- [ ] 6.6 `npx tsc --noEmit` → 0 errores — 2m
- [ ] 6.7 `npm test` → 100% verde (≥ 322 + tests nuevos de esta change) — 10m
- [ ] 6.8 Smoke manual: `npm run dev`, `POST /api/clients` con payload válido, verificar en `npx prisma studio` — 15m

---

## Task Count Summary

| Fase | Tasks | Estimación |
|------|-------|------------|
| Phase 0 — Test DB setup | 8 | ~60m |
| Phase 1 — Schema + migration + seed | 12 | ~80m |
| Phase 2 — Domain + Application (TDD) | 18 | ~130m |
| Phase 3 — Infrastructure | 10 | ~150m |
| Phase 4 — HTTP + wiring | 8 | ~140m |
| Phase 5 — Remove sharedClientStore | 5 | ~35m |
| Phase 6 — Verificación final | 8 | ~40m |
| **TOTAL** | **69** | **~635m** |

## Batch Checkpoints for sdd-apply

| Batch | Fases | Condición de entrada |
|-------|-------|----------------------|
| Batch A | Phase 0 | Sin prerequisito |
| Batch B | Phase 1 | DB test levantada y baseline pasa |
| Batch C | Phase 2 | Migration aplicada a DB test |
| Batch D | Phase 3 | Use cases compilan y sus tests pasan |
| Batch E | Phase 4 | PrismaClientRepository y schemas listos |
| Batch F | Phase 5 | Suite completa verde post-HTTP |
| Batch G | Phase 6 | Todos los commits anteriores |

---
**Phase**: sdd-tasks
**Change**: clients-foundation
**Project**: ipnext-backend
**Artifact store**: hybrid
**Date**: 2026-05-09
