# Proposal: Scheduling Tasks Enrich

## Intent

`ScheduledTask` carries two structural problems and is missing the relations the Splynx task-detail view needs. (a) `scheduledDate String?` + `scheduledTime String?` are denormalized free-text columns — they break sort/comparison, duplicate the temporal axis, and don't model the Splynx domain (which exposes a Start datetime AND an End datetime as separate fields). (b) `clientId/clientName/assignedTo/assignedToId` are loose strings, not FKs — referential integrity is delegated to the frontend, and joins are impossible. Splynx's task detail also surfaces a Service, a Partner, a Reporter, Watchers, and Travel Time which the current model can't represent.

This change fixes the datetime bug (introduce `startDate DateTime?` + `endDate DateTime?`), promotes the loose strings to proper FKs (`customerId → Client`, `assigneeId → Admin`, plus new `serviceId → Service`, `partnerId → Partner`, `reporterId → Admin`), adds an M:N pivot `TaskWatcher (taskId, adminId)` with replace-set semantics (mirroring the partner pattern in change 2), adds `travelTimeTo Int?` + `travelTimeFrom Int?`, and keeps `description String?` as plain-text-or-HTML accepted as-is. Per the change 1 deprecation pattern we KEEP the legacy columns (`scheduledDate`, `scheduledTime`, `clientId`, `clientName`, `assignedTo`, `assignedToId`, `status`) as read-only deprecated for one release — a future cleanup change drops them. This makes rollback cheap and the database the source of truth without forcing a backfill we'd regret.

## Scope

### In Scope

- **Prisma schema** (`prisma/schema.prisma`):
  - Add `startDate DateTime?`, `endDate DateTime?` to `ScheduledTask`.
  - Add `customerId String?` (FK → `Client`, `ON DELETE SET NULL`).
  - Add `serviceId String?` (FK → `Service`, `ON DELETE SET NULL`).
  - Add `partnerId String?` (FK → `Partner`, `ON DELETE SET NULL`).
  - Add `reporterId String?` (FK → `Admin`, `ON DELETE SET NULL`).
  - Add `assigneeId String?` (FK → `Admin`, `ON DELETE SET NULL`).
  - Add `travelTimeTo Int?`, `travelTimeFrom Int?` (minutes; non-negative, validated in DTO).
  - New pivot model `TaskWatcher { taskId, adminId, @@id([taskId, adminId]) }`, `taskId` cascade-delete, `adminId` `ON DELETE Cascade` (watchers are pure join rows — when admin disappears the watcher row goes with them, no business value retained).
  - Indexes: `@@index([startDate])`, `@@index([endDate])`, `@@index([customerId])`, `@@index([serviceId])`, `@@index([partnerId])`, `@@index([assigneeId])`, `@@index([reporterId])` on `ScheduledTask`; `@@index([adminId])` on `TaskWatcher`.
  - Back-relations on `Client`, `Service`, `Partner`, `Admin` for Prisma client generation.
- **Prisma migration** (`prisma/migrations/<ts>_scheduling_tasks_enrich/migration.sql`):
  - DDL adds columns + FKs + pivot + indexes.
  - Data migration via `DO $$ ... $$` block: for every row where `startDate IS NULL` AND `scheduledDate IS NOT NULL`, attempt to parse `scheduledDate || 'T' || COALESCE(scheduledTime, '00:00') || ':00'` into a `timestamp`. On success set `startDate`. Set `endDate = startDate + (estimatedHours * INTERVAL '1 hour')`. On parse failure RAISE NOTICE per row id, leave both NULL. Idempotent (`WHERE "startDate" IS NULL AND "scheduledDate" IS NOT NULL`).
  - NO `ON CONFLICT ON CONSTRAINT <index_name>`. NO new UNIQUE constraints.
  - Legacy columns (`scheduledDate`, `scheduledTime`, `clientId`, `clientName`, `assignedTo`, `assignedToId`, `status`) are NOT dropped. Index on `scheduledDate` is retained until the cleanup change.
- **Domain layer** (`src/domain/`):
  - Extend `ScheduledTask` entity: add `startDate: string | null`, `endDate: string | null`, `customerId/serviceId/partnerId/reporterId/assigneeId: string | null`, `assigneeName: string | null` (derived from JOIN), `customerName: string | null` (derived), `watcherIds: string[]`, `travelTimeTo/From: number | null`.
  - Mark `scheduledDate`, `scheduledTime`, `clientId`, `clientName`, `assignedTo`, `assignedToId` as `@deprecated` JSDoc — still returned by the API for one release.
  - Widen `SchedulingRepository.createTask`/`updateTask` input types to include the new fields and `watcherIds?: string[]`.
  - New domain error: `ReferenceNotFoundError` (parameterized — mirrors change 2 §AD-7), kinds: `customer | service | partner | reporter | assignee | watcher`.
- **Application layer**:
  - Rewrite `src/application/dto/scheduling.dto.ts`:
    - Add `startDate: z.string().datetime({ offset: true }).nullable().optional()`, `endDate` same shape.
    - Add `customerId/serviceId/partnerId/reporterId/assigneeId: z.string().min(1).nullable().optional()` (NOT `.uuid()` — change 1 lesson on mixed ID formats).
    - Add `watcherIds: z.array(z.string().min(1)).optional()` (replace-set when present, untouched when omitted).
    - Add `travelTimeTo/From: z.number().int().nonnegative().nullable().optional()`.
    - Add `endDateAfterStart` superRefine: when both present, `endDate >= startDate`.
    - Keep deprecated fields (`scheduledDate`, `scheduledTime`, `clientId`, `clientName`, `assignedTo`, `assignedToId`) optional in the schema for one release — accepted but not required.
  - Update `CreateTask` and `UpdateTask` use cases to validate FK existence (`customerId`, `serviceId`, `partnerId`, `reporterId`, `assigneeId`, each `watcherIds[i]`) by calling existing repos. On missing reference, throw `ReferenceNotFoundError(kind, id)`.
  - No new use cases — watcher replace-set is part of `UpdateTask`.
- **HTTP layer**:
  - Update `src/infrastructure/http/routes/scheduling.routes.ts`:
    - Pass the FK lookup repos through the factory signature.
    - Catch `ReferenceNotFoundError` → translate to 404 with the corresponding `code` via a `REFERENCE_TO_CODE` const map.
  - No new routes. No URL changes.
- **Adapters**:
  - Rewrite `PrismaSchedulingRepository`:
    - `INCLUDE` adds `customer: { select: { id, name } }`, `assignee: { select: { id, name } }`, `watchers: { include: { admin: { select: { id, name } } } }`, plus `service`, `partner`, `reporter`.
    - `toTask` maps `startDate`/`endDate` to ISO strings, derives `customerName` from `customer.name` (fallback to legacy `clientName`), derives `assigneeName` from `assignee.name` (fallback to legacy `assignedTo`).
    - `createTask` / `updateTask` runs inside a transaction when `watcherIds` is present (scalar update + `taskWatcher.deleteMany` + `taskWatcher.createMany`).
  - Rewrite `InMemorySchedulingRepository` to mirror the same surface: watcherIds stored as an array on the in-memory task; FK existence validation lives at the use-case layer, not the in-memory adapter.
- **Wiring** (`src/infrastructure/http/app.ts`): pass the new lookup repos (already constructed elsewhere: `clientRepo`, `serviceRepo`, `partnerRepo`, `adminRepo`) into `createSchedulingRouter`. **Flagged** — touches the god object.
- **Tests** (TDD red-first in apply):
  - Use-case unit tests for FK validation (one per kind), watcher replace-set, end-before-start rejection, travel-time non-negative.
  - Route integration tests via supertest covering: auth (already covered, smoke-only), 201 with new fields, 404 with each `*_NOT_FOUND` code, replace-set semantics, datetime ISO 8601 echo.
  - Adapter mapper test covering `toTask` for the new fields (legacy-row case, FK-resolved case, watchers list).
  - Composition test against `/api/scheduling/:id` and any sibling — guard from change 1 lesson.

### Out of Scope (deferred)

- Dropping legacy columns (`scheduledDate`, `scheduledTime`, `clientId`, `clientName`, `assignedTo`, `assignedToId`, `status`) — future cleanup change, mirrors change 1's status-column pattern.
- Task detail page UI — `scheduling-task-detail-page` (change 4).
- ChecklistTemplate items and `TaskChecklistItem` — `scheduling-checklists` (change 5).
- Kanban view, multi-select filters, custom views — `scheduling-tasks-views` (change 6).
- Frontend updates to `SchedulingDashboardPage.tsx` and `SchedulingMapsPage.tsx` — coordinated PR in `ipnext-frontend`. See "Frontend Coordination" below.
- Rich-text sanitization on `description` — explicit non-goal (see design §AD-6); consumer handles XSS.
- Priority enum localization (Splynx labels Baja/Media/Alta) — frontend-only concern. Backend enum stays `low/normal/high/urgent`.
- Refactor of the `app.ts` god object — separate change.
- Renaming `assignedTo`/`assignedToId` columns at the DB layer — deprecation cycle in place; rename is the cleanup change.

## Capabilities

### Modified Capabilities

- `scheduling` — delta spec at `openspec/changes/scheduling-tasks-enrich/specs/scheduling/spec.md` modifying the consolidated `openspec/specs/scheduling/spec.md` (which itself already absorbed change 1's delta).

### New Capabilities

None.

## Approach

1. **Schema** — edit `prisma/schema.prisma` adding the seven scalar columns + five FKs + the `TaskWatcher` pivot + the indexes + the back-relations. Mark legacy columns with `///` doc-comments noting deprecation.
2. **Migration** — `npm run prisma:migrate -- --name scheduling_tasks_enrich`. Hand-edit the generated SQL to append the `DO $$ ... $$` backfill block (Prisma migrate emits DDL only; data migration is appended). Verify NO `ON CONFLICT ON CONSTRAINT` was generated for the new indexes.
3. **Domain** — extend `ScheduledTask` entity; widen the port input types; add `ReferenceNotFoundError`.
4. **DTOs** — extend `scheduling.dto.ts` with the new fields + the `endDate >= startDate` `superRefine`. Keep deprecated fields optional. Update `CreateTaskInput`/`UpdateTaskInput` types via `z.infer`.
5. **Use cases** — modify `CreateTask` and `UpdateTask` to perform FK validation in a deterministic order (customer → service → partner → reporter → assignee → watchers; see design §AD-9). `UpdateTask` handles watcher replace-set by passing `watcherIds` through to the repo, which runs the transaction.
6. **Adapters** — rewrite `PrismaSchedulingRepository` mapper + write path; mirror in `InMemorySchedulingRepository`. Maintain backward compatibility for legacy fields in the output (they appear alongside the new ones for one release).
7. **Routes** — extend `createSchedulingRouter` signature with the lookup repos; map `ReferenceNotFoundError.kind` to HTTP `code` via a const map; catch and respond 404 (FK error).
8. **Wiring** — update `app.ts` to pass the new repos.
9. **Tests** — strict TDD red-first throughout. New unit + integration tests covering every FK error code, replace-set semantics, datetime parsing, end-before-start rejection.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modified | `ScheduledTask` gains 9 columns + 5 FKs; new `TaskWatcher` pivot; back-relations on `Client/Service/Partner/Admin` |
| `prisma/migrations/<ts>_scheduling_tasks_enrich/migration.sql` | New | DDL + `DO $$ ... $$` datetime backfill |
| `src/domain/entities/scheduling.ts` | Modified | Adds `startDate/endDate/customerId/customerName/serviceId/partnerId/reporterId/assigneeId/assigneeName/watcherIds/travelTimeTo/travelTimeFrom`; legacy fields marked `@deprecated` |
| `src/domain/ports/SchedulingRepository.ts` | Modified | Widen `createTask`/`updateTask` input types; no new methods |
| `src/domain/errors/scheduling.ts` | Modified | Add `ReferenceNotFoundError` (kinds: customer/service/partner/reporter/assignee/watcher) |
| `src/application/dto/scheduling.dto.ts` | Modified | Add new fields; add `endDateAfterStart` superRefine; keep deprecated fields optional |
| `src/application/use-cases/CreateTask.ts` | Modified | FK validation in deterministic order |
| `src/application/use-cases/UpdateTask.ts` | Modified | Conditional FK validation; pass `watcherIds` through |
| `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts` | Modified | New `INCLUDE`; mapper rewrite; transactional write when `watcherIds` present |
| `src/infrastructure/adapters/in-memory/InMemorySchedulingRepository.ts` | Modified | Mirror new fields + watcher array |
| `src/infrastructure/http/routes/scheduling.routes.ts` | Modified | Extended factory signature; error translation map |
| `src/infrastructure/http/app.ts` | Modified | Pass new lookup repos (≈10 added lines) — **flagged: god object** |
| `src/__tests__/application/use-cases/CreateTask.test.ts` | Modified/New | FK error cases; deterministic order |
| `src/__tests__/application/use-cases/UpdateTask.test.ts` | Modified/New | Watcher replace-set; end-before-start; travel-time |
| `src/__tests__/infrastructure/adapters/prisma/PrismaSchedulingRepository.test.ts` | New | Mapper test (legacy-row + FK-resolved + watchers) |
| `src/__tests__/infrastructure/http/routes/scheduling.routes.test.ts` | Modified | New-field 201; FK 404 codes; replace-set; datetime echo |
| `src/__tests__/infrastructure/http/scheduling-composition.test.ts` | New | Route shadowing sanity (change 1 lesson) |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Datetime backfill silently drops malformed rows | Medium | `DO $$ ... $$` block uses `BEGIN ... EXCEPTION WHEN OTHERS THEN RAISE NOTICE` per-row; ops sees the warnings in the migration log. Rows with NULL `startDate` post-migration appear in the API as `startDate: null` and the legacy `scheduledDate`/`scheduledTime` are still present for manual reconciliation. Documented in design §AD-2. |
| Replace-set on `watcherIds` quietly drops watchers on a partial array | Medium | Documented in spec REQ-WATCHER-1: array is authoritative WHEN PRESENT. If `watcherIds` is OMITTED in the PUT body, the existing set is preserved. Mirrors change 2's partner semantics. |
| Adding multiple FKs increases JOIN cost on `GET /api/scheduling` (list endpoint) | Low | Each include is a single LEFT JOIN by primary key; total = 6 JOINs. For the current scale (<1k tasks) this is well within budget. Indexes are in place. Flagged in design §AD-4 with the `select`-trimming alternative documented. |
| Legacy column retention bloats response payload | Low | One release of overlap. ≈80 bytes added per task. Trivial. The deprecation cycle is documented in change 1's pattern. |
| Touches `app.ts` god object | Medium | Justified — wiring is unavoidable. ≤10 added lines, no logic. Refactor is its own deferred change. |
| Migration SQL pitfall recurrence (change 1 lesson) | Low | NO `ON CONFLICT ON CONSTRAINT`. NO new UNIQUE constraints. The backfill is a plain `UPDATE` inside a `DO $$ ... $$` block. |
| Composition order pitfall (change 1 lesson) | Low | `/api/scheduling` has no sibling today, but the composition test is added as a sanity guard for future siblings. |
| FK validation order is non-deterministic across runs | Low | Use case validates in a documented fixed order (customer → service → partner → reporter → assignee → watchers). Tests assert that order. |
| Rich-text description used as an XSS vector | Medium | Server explicitly does NOT sanitize (see design §AD-6). The spec documents this as a non-goal. Frontend MUST render through DOMPurify (or equivalent) per coordination notes. |
| Naming-debt regression on adapter rewrites | Low | `PrismaSchedulingRepository.ts` already exports the correct class name. Verified at task close per change 1 lesson. |

## Frontend Coordination (NOT part of this change)

The frontend repo (`ipnext-frontend`) consumes these endpoints in `SchedulingDashboardPage.tsx`, `SchedulingMapsPage.tsx`, and the task create/edit drawer. A coordinated PR must:

- Update the `ScheduledTask` type with the new fields: `startDate/endDate: string | null` (ISO), `customerId/customerName/serviceId/partnerId/reporterId/assigneeId/assigneeName: string | null`, `watcherIds: string[]`, `travelTimeTo/From: number | null`.
- Treat the legacy fields (`scheduledDate`, `scheduledTime`, `clientId`, `clientName`, `assignedTo`, `assignedToId`) as `@deprecated` — read-only fallback for one release. Switch reads to `startDate`/`customerId`/`customerName`/`assigneeName` immediately; remove the legacy reads in the cleanup release.
- Send `startDate`/`endDate` as ISO 8601 with offset (`new Date(...).toISOString()`).
- Send `watcherIds: string[]` on PUT (replace-set semantics — array is authoritative).
- Render `description` through DOMPurify (or equivalent). Backend does NOT sanitize.
- Apply the `impeccable` skill on the task drawer per the change-1 frontend convention.

No URL changes. No breaking changes to existing fields (they continue to be returned).

## Rollback Plan

The migration is **schema-additive + data-additive**. Legacy columns are retained. Rollback is clean.

1. **Pre-merge safety net**: tag the commit immediately before merge (`pre-tasks-enrich`).
2. **App rollback**: `git revert` of the merge commit restores the old code. The old code reads only the legacy fields from `ScheduledTask`; the new columns sit idle.
3. **DB rollback (down direction)** — manual via `prisma migrate resolve` plus the SQL below:
   ```sql
   DROP TABLE IF EXISTS "TaskWatcher";
   DROP INDEX IF EXISTS "ScheduledTask_startDate_idx";
   DROP INDEX IF EXISTS "ScheduledTask_endDate_idx";
   DROP INDEX IF EXISTS "ScheduledTask_customerId_idx";
   DROP INDEX IF EXISTS "ScheduledTask_serviceId_idx";
   DROP INDEX IF EXISTS "ScheduledTask_partnerId_idx";
   DROP INDEX IF EXISTS "ScheduledTask_assigneeId_idx";
   DROP INDEX IF EXISTS "ScheduledTask_reporterId_idx";
   ALTER TABLE "ScheduledTask" DROP CONSTRAINT IF EXISTS "ScheduledTask_customerId_fkey";
   ALTER TABLE "ScheduledTask" DROP CONSTRAINT IF EXISTS "ScheduledTask_serviceId_fkey";
   ALTER TABLE "ScheduledTask" DROP CONSTRAINT IF EXISTS "ScheduledTask_partnerId_fkey";
   ALTER TABLE "ScheduledTask" DROP CONSTRAINT IF EXISTS "ScheduledTask_reporterId_fkey";
   ALTER TABLE "ScheduledTask" DROP CONSTRAINT IF EXISTS "ScheduledTask_assigneeId_fkey";
   ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "travelTimeTo";
   ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "travelTimeFrom";
   ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "assigneeId";
   ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "reporterId";
   ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "partnerId";
   ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "serviceId";
   ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "customerId";
   ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "endDate";
   ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "startDate";
   ```
   Data loss = any `startDate`/`endDate` set by writes between deploy and rollback. Recoverable from `scheduledDate`/`scheduledTime` (still populated by the legacy code path on rollback).
4. **Frontend**: no rollback needed — frontend treats new fields as optional with legacy fallbacks.

## Dependencies

- **Blocked by**:
  - `scheduling-foundation-stage-model` (change 1) — for `Stage` model + the deprecation pattern this change mirrors.
  - `scheduling-projects-enrich` (change 2) — for the replace-set pivot pattern (`TaskWatcher` mirrors `ProjectPartner`) and the `ReferenceNotFoundError` precedent.
  - `Client`, `Service`, `Partner`, `Admin` tables existing — all already in `prisma/schema.prisma`.
- **Blocks**: `scheduling-task-detail-page` (change 4) — the detail page renders the new fields.
- **No new npm packages.** Uses existing `zod`, `prisma`, `@prisma/client`.
- **No new Splynx calls.** Splynx is deprecated; snapshot YAML is reference only.

## Success Criteria

- [ ] `prisma migrate dev` applies cleanly on (a) a fresh DB and (b) a DB pre-populated with tasks from change 1/2.
- [ ] After migration, every row with `scheduledDate IS NOT NULL` has a non-null `startDate` (unless the string was unparseable, in which case the migration log shows a NOTICE).
- [ ] `POST /api/scheduling` with `startDate`/`endDate` ISO strings returns 201 and echoes them back as ISO strings.
- [ ] `POST /api/scheduling` with a non-existent `customerId/serviceId/partnerId/reporterId/assigneeId/watcherIds[i]` returns 404 with the corresponding `code` (`CUSTOMER_NOT_FOUND`, `SERVICE_NOT_FOUND`, `PARTNER_NOT_FOUND`, `REPORTER_NOT_FOUND`, `ASSIGNEE_NOT_FOUND`, `WATCHER_NOT_FOUND`).
- [ ] `PUT /api/scheduling/:id` with `watcherIds: ["a1","a2"]` then `watcherIds: ["a1"]` removes a2 (replace-set semantics).
- [ ] `PUT /api/scheduling/:id` with `endDate < startDate` returns 400 with `VALIDATION_ERROR`.
- [ ] `GET /api/scheduling/:id` returns both new fields AND legacy fields populated (during the deprecation window).
- [ ] `tsc --noEmit` clean; `npm test` green.
- [ ] Composition test passes.
- [ ] End-to-end smoke (see `tasks.md` §Smoke) passes against a deployed instance: login + create task with all new fields + verify `startDate` is real ISO + customer resolves + watchers list works + replace-set + DELETE.
