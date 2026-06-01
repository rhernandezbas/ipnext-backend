# Proposal: Service Technology Catalog (service-technology)

## Intent

Add an editable catalog table `ServiceTechnology` (technology types: Fiber, DOCSIS, Wireless, etc.) and a nullable column `technology` on the existing `Service` model. This replaces any future hardcoded enum with a catalog-driven dropdown, following the exact `TaskCategory` pattern already established in the codebase. The GR sync mirror MUST NOT overwrite the new column.

## Scope

### In Scope

- New `model ServiceTechnology` in `prisma/schema.prisma` (id, name unique, description optional, timestamps)
- New column `technology String?` on `model Service` — nullable, additive, no default
- Migration: two-step additive (new table first, then column on Service); no data loss; safe to run on live DB
- Seed: canonical values (Fiber, DOCSIS, Wireless, FTTH, HFC, Radio) with sensible defaults
- Domain entity `ServiceTechnology` in `src/domain/entities/serviceTechnology.ts`
- Port `ServiceTechnologyRepository` in `src/domain/ports/ServiceTechnologyRepository.ts`
- Domain errors in `src/domain/errors/serviceTechnology.ts` (NotFound, NameConflict, InUse)
- Adapters: `PrismaServiceTechnologyRepository` + `InMemoryServiceTechnologyRepository`
- Use cases (one file each, verb+noun): `CreateServiceTechnology`, `ListServiceTechnology`, `GetServiceTechnology`, `UpdateServiceTechnology`, `DeleteServiceTechnology`
- DTOs + Zod schemas in `src/application/dto/serviceTechnology.dto.ts`
- Router `serviceTechnologies.routes.ts` under `/api/service-technologies`
- Wiring in `app.ts` (minimal: one new constructor param + one `use()` call)
- Tests: use-case tests with `InMemoryServiceTechnologyRepository`; route tests with supertest

### Out of Scope

- Making `Service.technology` a FK relation (Phase 2 — would require destructive migration on live data)
- Frontend UI for the catalog admin (covered in `contracts-page` change)
- Splynx / GR integration changes
- Any modification to the existing `Service` CRUD use cases beyond confirming the sync guard

## Capabilities

### New Capabilities

- `service-technology-catalog`: Editable CRUD catalog for service technologies. Name is unique (case-insensitive check). Supports list, get, create, update, delete with appropriate error codes.
- `service-technology-assignment`: Nullable `technology` column on `Service`. Stores the technology name as a free string (no FK in Phase 1). The GR upsert (`PrismaClientMirrorRepository.upsertContract`) does NOT touch this column — confirmed by ADR 0004 and code review of the `data` object in that method.

### Modified Capabilities

- None — existing `Service` endpoints are unchanged. The new column is invisible to them until Phase 2 adds assignment UI.

## Approach

Mirror `TaskCategory` exactly:

1. SDD artifacts (this change)
2. Schema: new model + nullable column, generate additive migration
3. Domain: entity + port + typed errors
4. Application: 5 use cases + DTOs (Zod)
5. Infrastructure: InMemory adapter → Prisma adapter → router
6. Wire in `app.ts` minimally (God Object risk flag — see Risks)
7. Tests: TDD red → green → refactor; use cases with InMemory, routes with supertest
8. Seed: add canonical technology values alongside existing seeds

### Migration Strategy

Step 1 — run `npm run prisma:migrate`: generates two migrations automatically (Prisma batches model addition + column addition into one migration file). The column `technology` is nullable with no default — zero downtime on existing rows.

Step 2 — verify: `SELECT COUNT(*) FROM "Service" WHERE technology IS NOT NULL` should be 0 (expected on fresh add).

**Rollback plan**: the migration is purely additive. To roll back: drop column `technology` from `Service` and drop table `ServiceTechnology`. No existing data is affected. Prisma migration file must be deleted from `prisma/migrations/` and schema reverted. Recommended: test migration on staging DB before production.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `app.ts` God Object growth | Med | Add one factory function and one `use()` call only; document in design.md the DI wiring pattern used |
| GR sync overwrites `technology` | Low | Confirmed safe: `PrismaClientMirrorRepository.upsertContract` does not include `technology` in its `data` object (ADR 0004). Add a comment in that method as a guard note. |
| `Service` schema migration drops rows | Very Low | Column is nullable with no default; additive only. Review generated SQL before `prisma:migrate dev`. |
| Name collision with future FK migration | Low | Phase 1 stores name as string intentionally (same pattern as TaskCategory). Phase 2 is documented as explicit next step. |
| InUse guard complexity | Low | Delete guard checks `Service.technology === catalogEntry.name`; implemented at use-case level with InMemory repo supporting a `countByTechnology(name)` method |
