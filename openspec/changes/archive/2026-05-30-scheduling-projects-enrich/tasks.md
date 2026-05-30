# Tasks: Scheduling Projects Enrich

Hierarchical task list grouped by phase. Strict TDD — every implementation task is preceded by a red-first test task. Tasks aim for ≤1 hour each.

---

## Phase 1 — Infrastructure (schema + migration)

### [x] 1.1 Extend `prisma/schema.prisma`

- **File**: `prisma/schema.prisma`
- **Action**: Add to `model Project` the columns `typeId String?`, `categoryId String?`, `workflowId String?`, `projectLeadId String?`, `visible Boolean @default(true)`, plus the corresponding `@relation` lines to `ProjectType`, `ProjectCategory`, `Workflow`, `Admin` (all with `onDelete: SetNull`). Add `partners ProjectPartner[]` back-relation. Add indexes: `@@index([categoryId])`, `@@index([typeId])`, `@@index([workflowId])`, `@@index([projectLeadId])`, `@@index([visible])`.
- **Action**: Add new model `ProjectPartner { projectId String; partnerId String; project Project @relation(...) onDelete: Cascade; partner Partner @relation(...) onDelete: Restrict; @@id([projectId, partnerId]); @@index([partnerId]) }`. Add `projects ProjectPartner[]` back-relation on `Partner`. Add `projectsLed Project[]` back-relation on `Admin`. Add `projects Project[]` back-relations on `Workflow`, `ProjectCategory`, `ProjectType`.
- **Acceptance**: `npx prisma format` succeeds; `npx prisma validate` succeeds. ✓ DONE

### [x] 1.2 Generate migration

- **Command**: `npm run prisma:migrate -- --name scheduling_projects_enrich` (run by the user, not the agent).
- **Action**: Inspect the generated `migration.sql`. Compare against `design.md §Migration — Up SQL`. If the diff is purely cosmetic (column order, quoting), accept. If Prisma omitted the data backfill (it will — Prisma never auto-writes data migrations), append the `DO $$ ... WHERE NOT EXISTS $$` block from the design doc.
- **CRITICAL**: confirm the migration does NOT use `ON CONFLICT ON CONSTRAINT <name>` anywhere (change 1 lesson).
- **NOTE**: No DB was available during apply. Migration SQL written manually at `prisma/migrations/20260520010000_scheduling_projects_enrich/migration.sql`. User must run `prisma migrate deploy` against a live DB to apply.
- **Acceptance**: migration applies cleanly on a fresh DB AND on a DB containing existing rows from change 1.

### [x] 1.3 Verify down direction

- **Action**: Manually write down SQL (per design `§Migration — Down SQL`) into a comment block at the top of the migration file for future-us. Prisma does not auto-apply down, but having it ready as documentation prevents archeology.
- **Acceptance**: Down SQL is present in the migration file as a comment block titled `-- Down (manual)`. ✓ DONE

---

## Phase 2 — Domain layer

### [x] 2.1 [TEST] Extend `Project` entity expectations

- **File**: `src/__tests__/domain/entities/project.test.ts` (NEW)
- **Action**: Write a compilation-only test (`expectType`) asserting the new shape: `typeId/categoryId/workflowId/projectLeadId: string | null`, `visible: boolean`, `partners: Array<{ id: string, name: string }>`. Test runs red.
- **Acceptance**: `npm test` shows the new test failing on type-level.

### [x] 2.2 Update `Project` entity

- **File**: `src/domain/entities/project.ts`
- **Action**: Add the new fields per `design.md §Interfaces`. Keep `taskCounts` optional. Re-run test 2.1 → green.
- **Acceptance**: Test green; `tsc --noEmit` clean.

### [x] 2.3 Add domain error type

- **File**: `src/domain/errors/projects.ts` (NEW)
- **Action**: Export `ReferenceKind` union + `ReferenceNotFoundError extends Error` per the design.
- **Acceptance**: File compiles; import works from application layer.

### [x] 2.4 Widen `ProjectRepository` port

- **File**: `src/domain/ports/ProjectRepository.ts`
- **Action**: Add `CreateProjectInput`, `UpdateProjectInput`, `ListProjectsFilter` types; update method signatures per the design. The widening is intentionally non-breaking at the call site (all new fields optional).
- **Acceptance**: `tsc --noEmit` clean across the project.

---

## Phase 3 — DTO + Application layer

### [x] 3.1 [TEST] DTO schema tests

- **File**: `src/__tests__/application/dto/projects.dto.test.ts` (NEW)
- **Action**: Red-first tests for `CreateProjectSchema`, `UpdateProjectSchema`, `ListProjectsQuerySchema`. Cover: required `title`, rejection of non-UUID FK strings, rejection of `partnerIds: "x"` (must be array), rejection of `visible: "yes"`, acceptance of all-null FKs.
- **Acceptance**: Test file fails (schemas don't exist).

### [x] 3.2 Implement DTOs

- **File**: `src/application/dto/projects.dto.ts` (NEW)
- **Action**: Implement per design sketch.
- **Acceptance**: Tests in 3.1 green.

### [x] 3.3 [TEST] `ListProjects` use case

- **File**: `src/__tests__/application/use-cases/ListProjects.test.ts` (NEW)
- **Action**: Red-first. Cover: empty list returns `[]`; with-filter `{ visible: true }` excludes invisible projects; `taskCounts` shape correct.
- **Acceptance**: Test fails (use case doesn't exist).

### [x] 3.4 Implement `ListProjects`

- **File**: `src/application/use-cases/ListProjects.ts` (NEW)
- **Action**: Thin pass-through to `repo.list(filter)`. Use case validates the filter object structure (only `visible` allowed).
- **Acceptance**: 3.3 green.

### [x] 3.5 [TEST] `GetProject` use case

- **File**: `src/__tests__/application/use-cases/GetProject.test.ts` (NEW)
- **Action**: Red-first. Cover: returns project when ID exists; returns `null` when missing.
- **Acceptance**: Test fails.

### [x] 3.6 Implement `GetProject`

- **File**: `src/application/use-cases/GetProject.ts` (NEW)
- **Acceptance**: 3.5 green.

### [x] 3.7 [TEST] `CreateProject` use case — FK validation

- **File**: `src/__tests__/application/use-cases/CreateProject.test.ts` (NEW)
- **Action**: Red-first. Cover: happy path (no FKs); happy path (all FKs valid); throws `ReferenceNotFoundError('category')` when categoryId points at nothing; same for type/workflow/lead; throws `ReferenceNotFoundError('partner')` when any partnerIds[i] missing. Use `InMemory*Repository`s with seeded fixtures.
- **Acceptance**: Tests fail.

### [x] 3.8 Implement `CreateProject`

- **File**: `src/application/use-cases/CreateProject.ts` (NEW)
- **Action**: Sequential lookups against the five lookup repos; on miss throw `ReferenceNotFoundError`; else delegate to `repo.create(input)`. Dedupe `partnerIds` before lookup.
- **Acceptance**: 3.7 green.

### [x] 3.9 [TEST] `UpdateProject` use case — partial FK validation + replace-set

- **File**: `src/__tests__/application/use-cases/UpdateProject.test.ts` (NEW)
- **Action**: Red-first. Cover: PUT with `partnerIds: ["p1", "p2"]` then PUT with `partnerIds: ["p1"]` removes p2 (replace-set); PUT omitting `partnerIds` preserves existing set; PUT with unknown FK throws `ReferenceNotFoundError`; PUT with `categoryId: null` clears the FK; returns `null` when project not found.
- **Acceptance**: Tests fail.

### [x] 3.10 Implement `UpdateProject`

- **File**: `src/application/use-cases/UpdateProject.ts` (NEW)
- **Action**: Conditional FK lookups (only for fields present in the body, treating `null` as "clear" — skip lookup). Delegate to `repo.update`.
- **Acceptance**: 3.9 green.

### [x] 3.11 [TEST] `DeleteProject` use case

- **File**: `src/__tests__/application/use-cases/DeleteProject.test.ts` (NEW)
- **Action**: Red-first. Cover: returns `true` on success; `false` on missing ID.
- **Acceptance**: Test fails.

### [x] 3.12 Implement `DeleteProject`

- **File**: `src/application/use-cases/DeleteProject.ts` (NEW)
- **Acceptance**: 3.11 green.

---

## Phase 4 — Infrastructure layer

### [x] 4.1 Update `InMemoryProjectRepository`

- **File**: `src/infrastructure/adapters/in-memory/InMemoryProjectRepository.ts`
- **Action**: Extend the in-memory store to include the new fields; implement transactional `update` semantics for `partnerIds` (replace-set on the in-memory Map). All use-case tests in Phase 3 should now pass against this adapter.
- **Acceptance**: All Phase-3 tests green.

### [BLOCKED: no DB] 4.2 [TEST] `PrismaProjectRepository` tests

- **File**: `src/__tests__/infrastructure/adapters/prisma/PrismaProjectRepository.test.ts` (NEW or extended)
- **Action**: Use the existing pattern (transactional Prisma client teardown). Red-first tests for: `list()` returns the new shape and counts derived from `Stage.category`; `update()` partner replace-set is atomic (rollback on missing partner — although missing partners are caught in the use-case layer, the adapter still must run inside a tx); `delete()` cascades `ProjectPartner` rows.
- **Acceptance**: Tests fail.

### [x] 4.3 Rewrite `PrismaProjectRepository`

- **File**: `src/infrastructure/adapters/prisma/PrismaProjectRepository.ts`
- **Action**: Use `include: { type: true, category: true, workflow: true, projectLead: { select: { id, name } }, partners: { include: { partner: { select: { id, name } } } }, tasks: { select: { stage: { select: { category: true } } } } }` for `list/get/update`. Implement `update` as `prisma.$transaction([...])`: scalar `update` + `projectPartner.deleteMany({ where: { projectId: id } })` + `projectPartner.createMany({ data: ... })` when `partnerIds` is defined. Class name MUST match file name (no `InMemory*` debt).
- **Acceptance**: 4.2 green; visual sanity check on a Prisma Studio session.

---

## Phase 5 — HTTP layer

### [x] 5.1 [TEST] Route integration tests — auth

- **File**: `src/__tests__/infrastructure/http/routes/projects.routes.test.ts` (NEW)
- **Action**: Red-first. Cover REQ-AUTH-1..7: every route returns 401 without a cookie; valid cookie passes through. Use a stub `AuthProvider` that toggles success/failure.
- **Acceptance**: Tests fail (no middleware yet).

### [x] 5.2 [TEST] Route integration tests — validation + happy path + FK errors

- **File**: same as 5.1
- **Action**: Red-first. Cover REQ-CREATE-1..10, REQ-UPDATE-1..5, REQ-PARTNERS-1..5, REQ-DELETE-1..3, REQ-LIST-1..4, REQ-GET-1..2, REQ-SHAPE-1..3.
- **Acceptance**: Tests fail.

### [x] 5.3 Rewrite `projects.routes.ts`

- **File**: `src/infrastructure/http/routes/projects.routes.ts`
- **Action**: New factory signature `createProjectsRouter(listProjects, getProject, createProject, updateProject, deleteProject, authProvider)`. Apply `createAuthMiddleware(authProvider)` to the router. Wrap each handler: `safeParse` against the matching schema → 400 on fail; call use case; catch `ReferenceNotFoundError` → translate via the `REFERENCE_TO_CODE` map to 404 with the right `code`. Return DTOs (entity already matches the API shape per design).
- **Acceptance**: 5.1 + 5.2 green.

### [x] 5.4 [TEST] Composition test

- **File**: `src/__tests__/infrastructure/http/projects-composition.test.ts` (NEW)
- **Action**: Mount `createProjectsRouter` (with in-memory deps) at `/api/projects` and assert routes resolve: GET `/api/projects`, GET `/api/projects/abc`, PUT `/api/projects/abc`. Validate no accidental shadowing. Documented as a guard against the change-1 composition-order pitfall.
- **Acceptance**: Test passes.

---

## Phase 6 — Wiring

### [x] 6.1 Update `app.ts` wiring (FLAGGED — god object)

- **File**: `src/infrastructure/http/app.ts`
- **Action**: Replace the line `app.use('/api/projects', createProjectsRouter(projectRepo));` with the new construction:
  ```ts
  const listProjects   = new ListProjects(projectRepo);
  const getProject     = new GetProject(projectRepo);
  const createProject  = new CreateProject(projectRepo, projectCategoryRepo, projectTypeRepo, workflowRepo, adminRepo, partnerRepo);
  const updateProject  = new UpdateProject(projectRepo, projectCategoryRepo, projectTypeRepo, workflowRepo, adminRepo, partnerRepo);
  const deleteProject  = new DeleteProject(projectRepo);
  app.use('/api/projects', createProjectsRouter(listProjects, getProject, createProject, updateProject, deleteProject, authAdapter));
  ```
- **Action**: Confirm `projectCategoryRepo`, `projectTypeRepo`, `workflowRepo`, `adminRepo`, `partnerRepo` are already constructed earlier in `app.ts` (post change 1). If any lookup wrapper is missing (e.g. `partnerRepo.findByIds` or `adminRepo.findById`), add a 2-line method on the port + adapter — flag as a sub-task.
- **Action**: Document the added line count in the PR description (target ≤15 added lines).
- **Acceptance**: `tsc --noEmit` clean; `npm test` green.

### [x] 6.2 If lookup methods missing on existing repos — add them

- **File**: `src/domain/ports/{PartnerRepository,AdminRepository}.ts` and matching adapters
- **Action**: Add `findById(id): Promise<Entity | null>` (most likely already exists) and `findByIds(ids: string[]): Promise<Entity[]>` (likely needs adding on `PartnerRepository`). Keep adapter changes <10 lines each.
- **Acceptance**: All tests green.

---

## Phase 7 — Final verification

### [x] 7.1 Type check

- **Command**: `tsc --noEmit`
- **Acceptance**: Zero errors.

### [x] 7.2 Full test run

- **Command**: `npm test`
- **Acceptance**: Green. Coverage MAY drop in unrelated files; the new files MUST hit every spec requirement (cross-check `specs/projects/spec.md`).

### [x] 7.3 DIP audit

- **Action**: Grep the new files for `@infrastructure/`. Expect zero matches in any file under `src/application/` or `src/domain/`.
- **Acceptance**: No matches.

### [x] 7.4 Naming-debt audit

- **Action**: Confirm `PrismaProjectRepository.ts` exports class `PrismaProjectRepository` (already correct, but re-verify post-rewrite).
- **Acceptance**: File name matches class name.

### [x] 7.5 Composition order audit

- **Action**: Re-read `app.ts` lines mounting `/api/projects`. Confirm no other router shares the `/api/projects` prefix. If a future PR adds one (e.g. `/api/projects/templates`), the composition test from 5.4 will catch shadowing.
- **Acceptance**: Documented in PR description.

---

## Phase 8 — End-to-End Smoke Test (post-deploy, manual)

**Why**: Change 1 taught us GH Actions green ≠ production correct (the migration SQL only failed against a real Postgres). This phase is a paranoid checklist for the user / orchestrator to run after deploying to the target environment.

Assume `$API` is the base URL (e.g. `https://api.ipnext.staging`) and that an `admin@ipnext.local` user exists with password `<password>`.

### 8.1 Login

```bash
curl -i -c cookies.txt -X POST "$API/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@ipnext.local","password":"<password>"}'
# Expect: 200 OK + Set-Cookie: auth_token=...
```

### 8.2 Anonymous request rejected (sanity for the auth fix)

```bash
curl -i "$API/api/projects"
# Expect: 401 + {"code":"UNAUTHORIZED"}
```

### 8.3 List existing projects

```bash
curl -i -b cookies.txt "$API/api/projects" | tee /tmp/projects.json
# Expect: 200; every project has visible:true and workflowId set to Default (or null if Default missing)
```

### 8.4 Lookup IDs for FK payload

```bash
# Get the Default workflow id
curl -s -b cookies.txt "$API/api/scheduling/workflows" | jq '.[0].id' > /tmp/wf.id
# Get the first project category id
curl -s -b cookies.txt "$API/api/scheduling/project-categories" | jq '.[0].id' > /tmp/cat.id
# Get the first partner id
curl -s -b cookies.txt "$API/api/partners" | jq '.[0].id' > /tmp/p1.id
# Get an admin id
curl -s -b cookies.txt "$API/api/admins" | jq '.[0].id' > /tmp/lead.id
```

### 8.5 Create a full-payload project

```bash
curl -i -b cookies.txt -X POST "$API/api/projects" \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"Smoke Test Project\",\"description\":\"e2e\",\"categoryId\":$(cat /tmp/cat.id),\"workflowId\":$(cat /tmp/wf.id),\"projectLeadId\":$(cat /tmp/lead.id),\"visible\":true,\"partnerIds\":[$(cat /tmp/p1.id)]}" \
  | tee /tmp/created.json
# Expect: 201; body contains all sent FKs + partners: [{id, name}]
PROJECT_ID=$(jq -r .id /tmp/created.json)
```

### 8.6 GET the project — confirm FKs resolved

```bash
curl -i -b cookies.txt "$API/api/projects/$PROJECT_ID"
# Expect: 200; categoryId / workflowId / projectLeadId / partners populated
```

### 8.7 Negative: unknown category

```bash
curl -i -b cookies.txt -X POST "$API/api/projects" \
  -H 'Content-Type: application/json' \
  -d '{"title":"bad","categoryId":"00000000-0000-0000-0000-000000000000"}'
# Expect: 404 + {"code":"CATEGORY_NOT_FOUND"}
```

### 8.8 Replace-set partner update

```bash
# Remove the partner
curl -i -b cookies.txt -X PUT "$API/api/projects/$PROJECT_ID" \
  -H 'Content-Type: application/json' \
  -d '{"partnerIds":[]}'
# Expect: 200; partners: []
# Re-add
curl -i -b cookies.txt -X PUT "$API/api/projects/$PROJECT_ID" \
  -H 'Content-Type: application/json' \
  -d "{\"partnerIds\":[$(cat /tmp/p1.id)]}"
# Expect: 200; partners: [{id, name}]
```

### 8.9 Visible filter

```bash
curl -i -b cookies.txt -X PUT "$API/api/projects/$PROJECT_ID" -H 'Content-Type: application/json' -d '{"visible":false}'
curl -s -b cookies.txt "$API/api/projects?visible=true"  | jq "map(.id) | index(\"$PROJECT_ID\")"
# Expect: null  (the project is filtered out)
curl -s -b cookies.txt "$API/api/projects"               | jq "map(.id) | index(\"$PROJECT_ID\")"
# Expect: a number  (still present without filter)
```

### 8.10 Cleanup

```bash
curl -i -b cookies.txt -X DELETE "$API/api/projects/$PROJECT_ID"
# Expect: 204
# Confirm cascade: the previously linked partner still exists
curl -s -b cookies.txt "$API/api/partners/$(cat /tmp/p1.id)" | jq .id
# Expect: the partner ID (NOT deleted)
```

### 8.11 Smoke result

- If all 10 steps return the expected status, the change is verified in the target environment.
- If any step fails: capture the response body, run `prisma migrate status`, and check whether the migration applied (this is exactly the failure mode from change 1 — DB drift between CI and prod).
