# Proposal: Scheduling Projects Enrich

## Intent

Today the `Project` entity is reduced to `id + title + description + timestamps` and a derived `taskCounts` computed against the **legacy** `ScheduledTask.status` string. Splynx's project create/edit form (see `md/splynx-scheduling/screenshots/scheduling-project-add-form.png` and `md/splynx-scheduling/snapshots/scheduling-project-add-form-snapshot.yml`) exposes seven fields: **Título, Description, Tipo, Socios (M:N), Project lead, Categoría, Flujo de Trabajo**, plus a `Visible` toggle present in the listing.

Change `scheduling-foundation-stage-model` (the previous one in this 6-change initiative) already landed `Workflow`, `Stage`, `ProjectCategory` and `ProjectType` tables but did NOT connect them to `Project`. This change wires them in, adds the M:N `Project ↔ Partner` relation, adds `projectLeadId` (FK `Admin`), `visible Boolean`, switches `taskCounts` to count off `Stage.category` (the source of truth post-foundation), and refactors `projects.routes.ts` to add zod validation + auth middleware. The router is currently **mounted without `createAuthMiddleware`**, exposing project CRUD to anonymous callers — change 6 was originally scoped to fix this but since this change rewrites the same file end-to-end, we fix it here (opportunistic and reasoned through in the Risks section).

## Scope

### In Scope

- **Prisma schema**:
  - Extend `Project` with `typeId String?` (FK `ProjectType`), `categoryId String?` (FK `ProjectCategory`), `workflowId String?` (FK `Workflow`), `projectLeadId String?` (FK `Admin`), `visible Boolean @default(true)`.
  - New pivot model `ProjectPartner { projectId String, partnerId String, @@id([projectId, partnerId]) }` with cascade on project delete and restrict on partner delete (partners are master data shared elsewhere — should not vanish silently when used).
  - Indexes: `@@index([categoryId])`, `@@index([typeId])`, `@@index([workflowId])`, `@@index([projectLeadId])`, `@@index([visible])` on `Project`; `@@index([partnerId])` on `ProjectPartner`.
- **Prisma migration**:
  - DDL adds columns + pivot + indexes.
  - Data migration backfills `workflowId` on existing projects with the ID of the seeded `"Default"` workflow (lookup by name). All other new FKs remain `NULL`. `visible` defaults to `true`. `ProjectPartner` stays empty.
  - Uses `DO $$ ... WHERE NOT EXISTS $$` for any bootstrap insert (see lessons from change 1). NEVER uses `ON CONFLICT ON CONSTRAINT <index_name>`.
- **Domain entities**: extend `Project` with the new fields; add a derived `ProjectListItem` returned by `list()` that includes `taskCounts` grouped by `Stage.category` (`nuevo | enProgreso | hecho`) **derived from the stage of each linked task**, not from legacy `status`.
- **Domain port `ProjectRepository`**: keep CRUD shape but widen the input/update DTO to accept all new fields; partners are managed inside a single transactional `update` (replace-set semantics — the body `partnerIds: string[]` replaces the existing set atomically). No separate sub-method, to keep the port narrow (see design §AD-5).
- **Application layer**:
  - New `src/application/dto/projects.dto.ts` with `CreateProjectSchema`, `UpdateProjectSchema`, `ListProjectsQuerySchema` (optional `visible` filter).
  - New use cases: `ListProjects`, `GetProject`, `CreateProject`, `UpdateProject`, `DeleteProject`. Use cases validate referential integrity (category/type/workflow/lead/partners must exist) by calling thin lookup methods on existing repos (no new ports).
  - Use cases SHALL NOT call zod themselves — route layer does that (consistent with the rest of the codebase).
- **HTTP**:
  - Rewrite `src/infrastructure/http/routes/projects.routes.ts`:
    - Add `createAuthMiddleware(authProvider)` (security fix).
    - Replace inline title-only validation with `safeParse` against the new DTO schemas.
    - Single `PUT /:id` accepts all fields including `partnerIds?: string[]` (replace-set). No separate sub-routes — see design §AD-6.
  - Sign of the factory changes — `app.ts` wiring must be updated.
- **Wiring (`app.ts`)**: rebuild `createProjectsRouter` call to pass `authProvider` + new use cases + the four lookup repos (`ProjectCategoryRepository`, `ProjectTypeRepository`, `WorkflowRepository`, partner repo, admin repo) needed for FK validation. **Flagged** — touches god object.
- **Composition test**: `/api/projects` does NOT currently share a prefix with another router (only one router mounted there), but per change-1 lessons we add a route-shadowing sanity test for `/api/projects/:id` vs. any potential future siblings (small, future-proofs).
- **Tests** (TDD red-first in apply): unit tests for each use case against `InMemoryProjectRepository` extended with the new fields; route integration tests with supertest covering auth, validation, FK errors, partner replace-set, visible filter, taskCounts shape.

### Out of Scope (deferred)

- Changes to `ScheduledTask` fields — `scheduling-tasks-enrich` (change 3).
- Task detail page — `scheduling-task-detail-page` (change 4).
- `ChecklistTemplate` items and `TaskChecklistItem` — `scheduling-checklists` (change 5).
- Kanban view (and what would have been the auth fix on this file) — `scheduling-tasks-views` (change 6). The auth fix migrates from change 6 to this change; everything else in change 6 stays as planned.
- Dropping legacy `ScheduledTask.status` column — still deprecated, dropped in change 3.
- Frontend changes to `SchedulingProjectsPage.tsx` and the project create/edit form — coordinated PR in `ipnext-frontend`, NOT part of this change. See "Frontend Coordination" below.
- The naming-debt audit (`known_debt.naming-mismatch`) — `PrismaProjectRepository.ts` already exports the correct class name; no other adapter is touched, so no remediation here.
- Renaming/refactoring the `app.ts` god object — `known_debt.god-object-app`, separate change.

## Capabilities

### New Capabilities

- `projects` — full HTTP capability for project CRUD with the enriched model. No prior `openspec/specs/projects/` directory exists (verified during planning), so this is a **new** capability spec file at `openspec/specs/projects/spec.md`. The change ships the spec under `openspec/changes/scheduling-projects-enrich/specs/projects/spec.md`.

### Modified Capabilities

None — `scheduling` is unchanged (we read `Stage.category` but the scheduling capability already exposes it post change 1). `scheduling-workflows` is unchanged. The new dependencies flow `projects → scheduling-workflows` (read-only lookup).

## Approach

1. **Schema** — extend `Project` and add `ProjectPartner` pivot in `prisma/schema.prisma`. Run `npm run prisma:migrate -- --name scheduling_projects_enrich`.
2. **Data migration** — inside the same Prisma migration file, append a `DO $$ ... WHERE NOT EXISTS $$` block (or plain `UPDATE`) that sets `workflowId = (SELECT id FROM "Workflow" WHERE name = 'Default' LIMIT 1)` for every existing project where `workflowId IS NULL`. Idempotent.
3. **Domain** — extend `Project` entity; add `ProjectListItem` (or extend `Project`'s `taskCounts` shape — see design §AD-3); widen `ProjectRepository.create/update` parameter types.
4. **Adapters** — `PrismaProjectRepository` is fully rewritten: `list()` and `get()` `include` `category`, `type`, `workflow`, `projectLead`, `partners.partner` (M:N hop), and `tasks.stage.category` for the count grouping. `update()` runs a transaction: scalar update + `ProjectPartner.deleteMany` + `ProjectPartner.createMany` (replace-set). `InMemoryProjectRepository` mirrors the same surface.
5. **Use cases** — five thin use cases. `CreateProject`/`UpdateProject` validate FK existence by looking up via the four lookup repos. On missing FK, throw `CategoryNotFoundError | TypeNotFoundError | WorkflowNotFoundError | LeadNotFoundError | PartnerNotFoundError` (domain errors under `src/domain/errors/`).
6. **DTOs** — new file `src/application/dto/projects.dto.ts` with zod schemas. All new fields optional; `partnerIds` optional `string[]`; `visible` optional boolean.
7. **Routes** — rewrite `projects.routes.ts`: import `createAuthMiddleware`, `safeParse` against the zod schemas in `POST`/`PUT`, catch domain errors → translate to 404 with the appropriate `code`.
8. **Wiring** — update `app.ts`: change `createProjectsRouter(projectRepo)` to pass `(listProjects, getProject, createProject, updateProject, deleteProject, authAdapter)`. Use cases are constructed inline with the existing `projectCategoryRepo`, `projectTypeRepo`, `workflowRepo`, `partnerRepo`, and a thin admin-lookup wrapper (existing `AdminRepository` already exposes `findById`). **Flagged**.
9. **Tests** — strict TDD. Red-first on use cases against `InMemoryProjectRepository`; supertest covers auth (401 on every route without cookie), validation (400 with `VALIDATION_ERROR`), FK errors (404 with the right `code`), happy-path CRUD, partner replace-set semantics, `visible` filter, `taskCounts` derived from `Stage.category`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modified | `Project` gains 5 columns; new `ProjectPartner` pivot; 6 new indexes |
| `prisma/migrations/<ts>_scheduling_projects_enrich/migration.sql` | New | DDL + data backfill for `workflowId` (idempotent) |
| `src/domain/entities/project.ts` | Modified | Adds `typeId/categoryId/workflowId/projectLeadId/visible/partnerIds`; refines `taskCounts` provenance |
| `src/domain/ports/ProjectRepository.ts` | Modified | Widened `create/update` input; no new methods |
| `src/domain/errors/projects.ts` | New | `CategoryNotFoundError`, `TypeNotFoundError`, `WorkflowNotFoundError`, `LeadNotFoundError`, `PartnerNotFoundError` (or one `ReferenceNotFoundError` parameterized — see design §AD-7) |
| `src/application/dto/projects.dto.ts` | New | `CreateProjectSchema`, `UpdateProjectSchema`, `ListProjectsQuerySchema` |
| `src/application/use-cases/ListProjects.ts` | New | Returns `Project[]` with derived counts |
| `src/application/use-cases/GetProject.ts` | New | |
| `src/application/use-cases/CreateProject.ts` | New | Validates FK existence |
| `src/application/use-cases/UpdateProject.ts` | New | Validates FK existence; handles partner replace-set |
| `src/application/use-cases/DeleteProject.ts` | New | |
| `src/infrastructure/adapters/prisma/PrismaProjectRepository.ts` | Modified | Full rewrite: `include` joins, transactional `update`, count derivation off `Stage.category` |
| `src/infrastructure/adapters/in-memory/InMemoryProjectRepository.ts` | Modified | Mirror new fields and FK validation surface for tests |
| `src/infrastructure/http/routes/projects.routes.ts` | Modified | Auth middleware + zod validation + extended PUT |
| `src/infrastructure/http/app.ts` | Modified | New use-case construction + extended router call (≈15 added lines) — **flagged: god object** |
| `src/__tests__/application/use-cases/*Project*.test.ts` | New | TDD coverage of the 5 use cases |
| `src/__tests__/infrastructure/http/routes/projects.routes.test.ts` | New | Supertest auth + validation + happy path + FK errors |
| `src/__tests__/infrastructure/http/projects-composition.test.ts` | New | Route-shadowing sanity test (per change-1 lesson) |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Data migration leaves projects without `workflowId` because the Default workflow was never seeded (e.g. a dev DB that skipped seed) | Medium | Migration uses `WHERE NOT EXISTS` + a `SELECT` on Default; if no Default exists the projects keep `workflowId = NULL` (column stays nullable) and the API renders them. We deliberately keep the column nullable to avoid wedging an environment. Document a `prisma:seed` re-run as recovery. |
| **Opportunistic auth fix changes behavior** for any caller currently hitting `/api/projects` without a cookie | High | (a) Audit shows the only consumer is `SchedulingProjectsPage.tsx`, which is already inside the auth-gated app shell and sends the cookie. (b) Frontend coordination PR is paired with this. (c) Justification: an unauthenticated CRUD endpoint exposing project data is a real security bug; deferring it to change 6 leaves it open for weeks. The file is being rewritten anyway, so the marginal risk of folding the fix in is low and the marginal benefit (closing the hole now) is high. |
| Replace-set semantics on `partnerIds` quietly drop partners if the client sends a partial array | Medium | Documented in the spec (REQ-PARTNERS-1): the array is authoritative. PUT validates payload shape; if `partnerIds` is OMITTED the existing set is preserved (only replaced when the field is present). |
| `taskCounts` query becomes N+1 if naively implemented | Medium | `list()` uses a single `findMany` with `include: { tasks: { select: { stage: { select: { category: true } } } } }`. Counts are reduced in-process. For >10k tasks per project this is suboptimal; flagged in design §AD-4 with the GROUP BY alternative documented for later. |
| Touches `app.ts` god object | Medium | Justified — wiring is unavoidable (5 use cases + extended factory call). ≤15 added lines, no logic. Refactor is its own deferred change. |
| Migration SQL pitfall recurrence (change 1 lesson: `ON CONFLICT ON CONSTRAINT <index_name>` failed because the target was a UNIQUE INDEX, not a CONSTRAINT) | Low | Migration uses `DO $$ ... WHERE NOT EXISTS $$` for the workflow backfill (no `ON CONFLICT` needed). No new UNIQUE constraints are introduced in this change. |
| Composition order pitfall recurrence (change 1 lesson) | Low | `/api/projects` only has one router today; we still add a composition test as a sanity guard for future siblings (e.g. `/api/projects/templates`). |
| Naming-debt regression on adapter rewrites | Low | Only `PrismaProjectRepository.ts` is touched; its class name already matches. Verified at task close. |

## Frontend Coordination (NOT part of this change)

The frontend repo (`ipnext-frontend`) consumes these endpoints in `SchedulingProjectsPage.tsx` and the project create/edit form. A coordinated PR must:

- Update the `Project` type with the new optional fields (`typeId`, `categoryId`, `workflowId`, `projectLeadId`, `visible`, `partners: Array<{ id, name }>`).
- Update the form per the Splynx snapshot (`md/splynx-scheduling/snapshots/scheduling-project-add-form-snapshot.yml`): Tipo (select), Socios (multi-select), Project lead (select), Categoría (select), Flujo de Trabajo (select), plus the visible toggle in the list.
- Send `partnerIds: string[]` on PUT (replace-set semantics — the array is authoritative).
- Read `taskCounts` from the response (already present in shape; provenance changes but field names are stable: `nuevo | enProgreso | hecho | total`).
- Apply the `impeccable` skill on the form per the change-1 frontend convention.

No URL changes. No breaking changes to the response shape for existing fields.

## Rollback Plan

The migration is **schema-additive + data-additive**, so rollback is clean.

1. **Pre-merge safety net**: tag the commit immediately before merge (`pre-projects-enrich`).
2. **App rollback**: `git revert` of the merge commit restores the old code. The old code reads only `id/title/description/createdAt/updatedAt` from `Project`, so the extra columns sit idle without breaking anything.
3. **DB rollback (down direction)** — ship the down SQL alongside the up migration. Manually applied via `prisma migrate resolve` plus the SQL below:
   ```sql
   DROP TABLE IF EXISTS "ProjectPartner";
   ALTER TABLE "Project" DROP COLUMN IF EXISTS "visible";
   ALTER TABLE "Project" DROP COLUMN IF EXISTS "projectLeadId";
   ALTER TABLE "Project" DROP COLUMN IF EXISTS "workflowId";
   ALTER TABLE "Project" DROP COLUMN IF EXISTS "categoryId";
   ALTER TABLE "Project" DROP COLUMN IF EXISTS "typeId";
   -- indexes drop with the columns
   ```
   Data loss = the seeded `workflowId` backfill values and any partner links recorded between deploy and rollback. Both are recoverable: workflow can be re-backfilled by re-running the migration; partner links would need to come from app logs.
4. **Frontend**: no rollback needed — the frontend treats new fields as optional. If the frontend already deployed the consumer of the new fields, it gracefully renders them as `undefined`.
5. **Auth-fix rollback consideration**: reverting this PR re-opens the security hole on `/api/projects`. If the rollback happens, immediately deploy a one-line patch adding `createAuthMiddleware` even on the reverted code — this is cheaper than living with the exposure.

## Dependencies

- **Blocks**: `scheduling-tasks-enrich` (change 3) only loosely — change 3 doesn't strictly require this, but the order in `OVERVIEW.md` keeps the model evolution sequential.
- **Blocked by**: `scheduling-foundation-stage-model` (change 1) — must be merged and migrated so `Workflow`, `Stage`, `ProjectCategory`, `ProjectType` exist.
- **No new npm packages.** Uses existing `zod`, `prisma`, `@prisma/client`.
- **No new Splynx calls** — Splynx is deprecated; snapshot YAML is reference only.

## Success Criteria

- [ ] `prisma migrate dev` applies cleanly on (a) a fresh DB and (b) a DB pre-populated with projects under the change-1 schema.
- [ ] After migration, every existing project either has `workflowId = <Default workflow id>` or `workflowId = NULL` (with a logged warning if the Default workflow is missing).
- [ ] `GET /api/projects` returns 401 without an `auth_token` cookie.
- [ ] `POST /api/projects` with a body referencing a non-existent `categoryId/typeId/workflowId/projectLeadId/partnerIds[i]` returns 404 with the corresponding `code`.
- [ ] `PUT /api/projects/:id` with `partnerIds: ["p1","p2"]` then `partnerIds: ["p1"]` removes p2 (replace-set semantics).
- [ ] `GET /api/projects` `taskCounts` is computed from `Stage.category` of each linked task (not from legacy `status`).
- [ ] `GET /api/projects?visible=true` filters out projects with `visible=false` (when implemented per spec; otherwise this criterion is dropped if §AD-9 punts the filter).
- [ ] All five new use cases pass unit tests against `InMemoryProjectRepository`.
- [ ] Route integration tests cover auth + validation + happy path + FK errors + partner replace-set.
- [ ] `tsc --noEmit` clean; `npm test` green.
- [ ] Composition test passes (mount projects router + any sibling — currently none, but the test is in place).
- [ ] End-to-end smoke (see `tasks.md` §5) passes against a deployed instance: login + create project with all fields + GET to confirm FKs resolve + PUT to swap partners + DELETE.
