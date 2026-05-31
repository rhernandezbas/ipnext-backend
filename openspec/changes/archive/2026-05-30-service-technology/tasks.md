# Tasks: service-technology

STRICT TDD: write the test first (red), then the minimal code (green), then refactor.
Reference implementation to mirror: `TaskCategory` (entity, port, 5 use cases, both adapters, router, wiring).

## 1. Schema + Migration (infra)

- [ ] 1.1 Add `model ServiceTechnology` to `prisma/schema.prisma` (mirror `TaskCategory`, lines 485-493): `id`, `name @unique`, `description String?`, `createdAt`, `updatedAt`, `@@map("ServiceTechnology")`
- [ ] 1.2 Add `technology String?` column to `model Service` (lines 207-226) — nullable, additive, no default, with explanatory comment "Phase 1: free-text name, NOT a FK"
- [ ] 1.3 Generate migration SQL with `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script`
- [ ] 1.4 Create `prisma/migrations/<timestamp>_service_technology/migration.sql` with the generated additive SQL; review it is `CREATE TABLE` + `ADD COLUMN` only (no DROP)
- [ ] 1.5 Run `npx prisma generate` to refresh the Prisma client types
- [ ] 1.6 Add ServiceTechnology canonical values to `prisma/seed.ts` via `createMany({ skipDuplicates: true })` (Fiber, DOCSIS, Wireless, FTTH, HFC, Radio)

## 2. Domain (test-first where logic exists)

- [ ] 2.1 Create `src/domain/entities/serviceTechnology.ts` — interface `{ id, name, description }` (mirror `taskCategory.ts`)
- [ ] 2.2 Create `src/domain/errors/serviceTechnology.ts` — `ServiceTechnologyNotFoundError` (code `SERVICE_TECHNOLOGY_NOT_FOUND`), `ServiceTechnologyNameConflictError` (code `SERVICE_TECHNOLOGY_NAME_CONFLICT`), `ServiceTechnologyInUseError` (code `SERVICE_TECHNOLOGY_IN_USE`)
- [ ] 2.3 Create `src/domain/ports/ServiceTechnologyRepository.ts` — `list/getById/getByName/create/update/delete` + `countServicesUsingTechnology(name): Promise<number>`

## 3. Infrastructure adapters (in-memory first)

- [ ] 3.1 Create `src/infrastructure/adapters/in-memory/InMemoryServiceTechnologyRepository.ts` (mirror `InMemoryTaskCategoryRepository`); public `serviceCounts: Record<string, number>` test seam; `getByName` case-insensitive
- [ ] 3.2 Create `src/infrastructure/adapters/prisma/PrismaServiceTechnologyRepository.ts` (mirror `PrismaTaskCategoryRepository`); `countServicesUsingTechnology` → `prisma.service.count({ where: { technology: name } })`

## 4. Application — DTOs + use cases (TDD: test → use case)

- [ ] 4.1 Create `src/application/dto/serviceTechnology.dto.ts` — `ServiceTechnologyDTO` + Zod `CreateServiceTechnologySchema` (name required) and `UpdateServiceTechnologySchema` (all optional)
- [ ] 4.2 Test + impl `ListServiceTechnology` (`src/application/use-cases/ListServiceTechnology.ts`) — returns sorted by name
- [ ] 4.3 Test + impl `GetServiceTechnology` — throws `NotFound` when missing
- [ ] 4.4 Test + impl `CreateServiceTechnology` — case-insensitive name-conflict guard (mirror `CreateTaskCategory`)
- [ ] 4.5 Test + impl `UpdateServiceTechnology` — NotFound + name-conflict on rename
- [ ] 4.6 Test + impl `DeleteServiceTechnology` — NotFound + InUse guard via `countServicesUsingTechnology`

## 5. HTTP router (test-first with supertest)

- [ ] 5.1 Write `src/__tests__/infrastructure/http/routes/serviceTechnologies.routes.test.ts` covering ST-1…ST-5 (200/201/204/400/401/404/409 + error `code` strings), InMemory repo injected
- [ ] 5.2 Create `src/infrastructure/http/routes/serviceTechnologies.routes.ts` (mirror `taskCategories.routes.ts`): GET list, GET :id, POST, PUT :id, DELETE :id; paths `/service-technologies[/:id]`; `auth` middleware on all

## 6. Wiring (app.ts — minimal delta)

- [ ] 6.1 Add imports near TaskCategory imports (Prisma repo, router factory, 5 use cases)
- [ ] 6.2 Construct repo + 5 use cases near lines 620-625
- [ ] 6.3 Mount `app.use('/api', createServiceTechnologiesRouter(authAdapter, list, get, create, update, delete))` near lines 856-860

## 7. GR sync guard (no logic change)

- [ ] 7.1 Add inline comment above the `data` literal in `PrismaClientMirrorRepository.upsertContract` (line ~91) documenting that `technology` is intentionally excluded so it is never overwritten
- [ ] 7.2 (Optional) regression test asserting the `upsertContract` `data` object contains no `technology` key

## 8. Verification

- [ ] 8.1 `npm test` — all green (use-case + route suites)
- [ ] 8.2 `npx tsc --noEmit` — clean
- [ ] 8.3 Confirm no use case imports Prisma/Express (DIP check)
- [ ] 8.4 Conventional commit
