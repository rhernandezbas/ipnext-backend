# Archive Report — service-technology (SDD)

**Archived: 2026-05-30** · Verdict: PASS · Implemented and merged to feat/service-technology.

## What shipped

Service Technology catalog: full CRUD (`GET/POST/PUT/DELETE /api/service-technologies`) backed by a new `ServiceTechnology` Prisma model + domain entity + port + 5 use cases + in-memory adapter for tests. Nullable `technology String?` column added to `Service` model — additive migration, zero downtime. GR sync (`upsertContract`) confirmed safe: does not overwrite the new column. Global paginated services listing: `GET /api/services` with filters (status, technology, search) and pagination, backed by a dedicated `ServiceRepository` port. Seed: Fiber, DOCSIS, Wireless, FTTH, HFC, Radio.

## Commits (feat/service-technology)

- 1f6d99d9 feat(service-technology): ServiceTechnology catalog + contracts RBAC module
- 6723a33a feat(services): GET /api/services global paginated contracts listing

## Spec synced

Canonical capability spec → `openspec/specs/service-technology-catalog/spec.md` (NEW).

Covers three logical areas from the delta spec:
- `service-technology-catalog`: CRUD endpoints ST-1 through ST-6
- `service-technology-assignment`: nullable Service.technology column (ST-7)
- `services-listing`: global paginated contracts listing (SV-1)

## Follow-ups (deferred)

Phase 2: make `Service.technology` a proper FK relation to `ServiceTechnology` (requires destructive migration, deferred until live data volume is assessed). Frontend admin UI for catalog management (covered in `contracts-page` change).
