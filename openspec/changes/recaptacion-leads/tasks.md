# Tasks: recaptacion-leads (#80)

Strict TDD: red -> green -> refactor. Use-cases tested with InMemoryRecaptureRepository (never mock Prisma). Routes via supertest with in-memory repo. Targeted tests only.

## Phase 1 — BE domain + ports + errors
- [x] 1.1 domain/entities/recaptureLead.ts: types RecaptureLead, RecaptureContact, enums (Source/Status/Channel/Outcome) as string unions
- [x] 1.2 domain/errors/: RecaptureLeadNotFoundError, RecaptureLeadAlreadyClaimedError
- [x] 1.3 domain/ports/RecaptureRepository.ts: list, getById (with contacts), create, claim, claimNext, release, updateStatus, addContact, ingestChurned

## Phase 2 — BE use-cases (TDD with InMemory)
- [x] 2.1 InMemoryRecaptureRepository (test double, real port impl with atomic-claim semantics)
- [x] 2.2 ListRecaptureLeads (filters: status, assigneeId, unassigned; pagination) + test
- [x] 2.3 GetRecaptureLead (lead + contacts; NotFound) + test
- [x] 2.4 ClaimRecaptureLead (atomic; AlreadyClaimed when taken) + test (concurrent-ish: claim twice -> second fails)
- [x] 2.5 ClaimNextRecaptureLead (oldest free; none -> null) + test
- [x] 2.6 ReleaseRecaptureLead + test
- [x] 2.7 UpdateRecaptureLeadStatus + test
- [x] 2.8 AddRecaptureContact (appends; may advance lead status) + test
- [x] 2.9 IngestChurnedClients (from CustomerRepository where status='baja'; idempotent) + test
- [x] 2.10 DTOs + mappers in application/dto/recapture/

## Phase 3 — BE infra: Prisma + schema + migration
- [x] 3.1 prisma/schema.prisma: RecaptureLead, RecaptureContact models + 4 enums + partial unique index
- [x] 3.2 PrismaRecaptureRepository: claim/claimNext via updateMany guard (assigneeId IS NULL) returning count
- [x] 3.3 Migration 20260717000000_recapture_leads/migration.sql: CREATE TYPE enums, CREATE TABLE x2, FKs, partial unique index, indexes. Additive, no BEGIN/COMMIT
- [x] 3.4 Add 'recapture' to RBAC_MODULES (src/domain/entities/rbac.ts)
- [x] 3.5 Migration 20260717000100_grant_recapture_permissions/migration.sql: module + read/manage perms + grants to super_admin & administrador, idempotent
- [x] 3.6 seed.ts: idempotent grant block (mirror clients.manage pattern)

## Phase 4 — BE routes + wiring
- [x] 4.1 recapture.routes.ts: factory createRecaptureRouter(usecases..., authMiddleware, {read, manage}); 409 on claim conflict; 403 on missing perm; DTO outputs
- [x] 4.2 Route supertest (src/__tests__/recapture.routes.test.ts): read 403, manage 403, claim 409, list shape, contacts append, ingest idempotent
- [x] 4.3 Wire in app.ts: instantiate PrismaRecaptureRepository + use-cases; app.use('/api/recapture', createRecaptureRouter(...)) before errorHandler
- [x] 4.4 npx tsc --noEmit (BE) green

## Phase 5 — FE
- [x] 5.1 src/types/recaptacion.ts (RecaptureLead, RecaptureContact, enums, DTOs)
- [x] 5.2 src/api/recaptacion.api.ts (axios-client; list, get, claim, claimNext, release, updateStatus, addContact)
- [x] 5.3 src/hooks/useRecaptacion.ts (useQuery ['recaptacion', q] / ['recaptacion-lead', id]; mutations invalidate) + hook test (vi.mock api, retry:false)
- [x] 5.4 RecaptacionPage.tsx + .module.css: list (DataTable) + FilterBar (status/assignee/unassigned) + "Tomar siguiente" (Can manage)
- [x] 5.5 components/RecaptacionTableView, LeadDetailDrawer (timeline + register-contact form + claim/release buttons)
- [x] 5.6 hooks/useRecaptacionFilterUrl.ts (URL-backed filter state)
- [x] 5.7 App.tsx route `recaptacion` under customers (gate recapture.read) + Sidebar entry (recapture.read)
- [x] 5.8 Component/hook tests (Vitest) 7/7 passed; npx tsc --noEmit green (0 errors)

## Phase 6 — Verify + commit
- [ ] 6.1 Targeted suites: BE recapture use-cases + route; FE recapture hook/component
- [ ] 6.2 tsc/typecheck both repos
- [ ] 6.3 git add by explicit path; commit per repo on feat/80-recaptacion (NEVER main, NEVER push)
