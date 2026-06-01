# Verify Report — scheduling-foundation-stage-model

## Summary
- Tests: GREEN — 473 total, 71 suites, all passed
- Type check: CLEAN — `tsc --noEmit` produced zero errors
- Hexagonal boundary: PRESERVED — zero `@infrastructure/*` imports found in `src/application/`
- Naming convention: OK — all new `Prisma*Repository.ts` files export matching class names

---

## CRITICAL findings (block commit)

### 1. [scheduling.routes.ts:64] Sentinel `'stage-default-nuevo'` will cause FK violation in production

**File**: `src/infrastructure/http/routes/scheduling.routes.ts`, line 25 and 64

When `POST /api/scheduling` is called without a `stageId`, the route handler falls back to the sentinel string `'stage-default-nuevo'`:

```ts
const IN_MEMORY_DEFAULT_STAGE = 'stage-default-nuevo';
const stageId = data.stageId ?? IN_MEMORY_DEFAULT_STAGE;
```

This sentinel is then passed directly to `createTask.execute({ ..., stageId: 'stage-default-nuevo' })`, which in turn calls `prisma.scheduledTask.create({ data: { stageId: 'stage-default-nuevo' } })`. Since no `Stage` row has `id = 'stage-default-nuevo'`, Postgres will throw a FK violation (`ScheduledTask_stageId_fkey`). The result is an unhandled 500 in production for any `POST /api/scheduling` call that omits `stageId`.

The `PrismaSchedulingRepository.createTask()` has no special handling for this sentinel — it passes it straight to Prisma.

**REQ-STAGE-DEFAULT-1 is NOT honored in the production path.**

**Proposed fix**: Before calling `createTask.execute`, resolve the real default stage ID from the `StageRepository`. The `createSchedulingRouter` factory already accepts a `MoveTaskToStage` use case that depends on `StageRepository`, so `StageRepository` is available at wiring time. The cleanest fix is to pass a `StageRepository` (or a `defaultStageId: string` resolved once at startup) to `createSchedulingRouter`, so the production route can do:

```ts
// Option A — pass stageRepo to router factory and resolve at request time
const defaultStage = await stageRepo.getDefaultWorkflowStageByLegacyStatus('pending');
const stageId = data.stageId ?? defaultStage?.id;
if (!stageId) {
  res.status(500).json({ error: 'Default workflow not seeded', code: 'INTERNAL_ERROR' });
  return;
}
```

**Option B** (simpler for tests): keep the InMemory sentinel trick but move the default resolution into `PrismaSchedulingRepository.createTask` — if `stageId === 'stage-default-nuevo'`, look up the real ID. This is worse because it leaks a sentinel into the repository.

**Recommendation**: Option A. Add `stageRepo: StageRepository` as the last parameter of `createSchedulingRouter`. Tests already construct a `stageRepo`; update `app.ts` to pass `stageRepo` as well.

---

## WARNING findings (should fix before next change)

### 1. [PrismaSchedulingRepository.ts:179-186] Direct `status` write fallback is reachable and violates the design

**File**: `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts`, lines 179–186

The `updateTaskStatus` shim falls back to a direct `prisma.scheduledTask.update({ data: { status } })` when the Default workflow or the target stage cannot be found:

```ts
if (!stage) {
  // Fallback: direct status write (should not happen in normal operation)
  const row = await prisma.scheduledTask.update({ where: { id }, include: INCLUDE, data: { status } });
  return toTask(row);
}
```

Per Decision 2 of the design, `status` is a **read-only column** from the application layer's perspective after this migration. Writing it directly violates that contract and creates a divergence between `status` (DB column) and the derived `status` returned in responses (computed from `Stage.category`). More critically, this branch is reachable if the Default workflow is somehow deleted (e.g. by a concurrent `DELETE /api/scheduling/workflows/:id` that bypasses the guard in a race, or if the seed was never run in an environment). At that point, the response `status` field (derived from `stage.category`) would be inconsistent with what was written to the DB.

**Proposed fix**: Replace the fallback with an explicit error throw:

```ts
if (!stage) {
  throw new StageNotFoundError('default-workflow-stage-for-status:' + status);
}
```

This surfaces the missing-seed problem explicitly rather than silently writing stale data.

### 2. [schema.prisma:491] `stageId` is still nullable in the Prisma schema

**File**: `prisma/schema.prisma`, line 491:
```
stageId  String?
```

The migration SQL correctly makes it `NOT NULL` after backfill (line 116 of migration.sql). However, the Prisma schema still declares it as optional (`String?`). This means `prisma.scheduledTask.create({ data: { stageId: undefined } })` will compile without error — TypeScript won't catch the missing required field. In practice the DB will reject the insert (NOT NULL constraint), but the error will be a runtime Prisma error rather than a compile-time type error.

**Proposed fix**: Change `stageId String?` to `stageId String` in `prisma/schema.prisma` and regenerate the client. Since the migration already enforces NOT NULL in Postgres, the schema should reflect this. After running `prisma generate`, the type will also correctly require `stageId` in create payloads.

**Note**: This is a schema/code drift — the DB and the Prisma model are inconsistent. This does not block tests (which use in-memory repos), but will surface as a runtime FK violation in production for missing `stageId`.

### 3. [seed.ts:232] `(prisma as any).workflow` cast — will become unnecessary after `prisma generate`

**File**: `prisma/seed.ts`, line 232 and throughout `seedSchedulingFoundation()`

All access to the new `Workflow`, `Stage`, `ProjectCategory`, and `ProjectType` models uses `(prisma as any).<model>`. This is necessary NOW because `@prisma/client` has not been regenerated against the new schema (no local DB accessible during apply phase). Once `npx prisma generate` is run in the deployment environment, these casts become unnecessary and the code should be updated to use typed access (`prisma.workflow`, `prisma.stage`, etc.).

The cast is not wrong as a temporary measure, but it is tech debt that should be cleaned up in the same deployment step that runs the migration. Until then, typos in model names will only surface at runtime.

### 4. [PrismaSchedulingRepository.ts:146] `moveTaskToStage` returns `null` on any Prisma error, masking FK violations

**File**: `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts`, lines 139–160

The `moveTaskToStage` method catches ALL errors and returns `null`:

```ts
} catch {
  return null;
}
```

If `stageId` does not exist in the DB (FK violation), this swallows the error and returns `null`, causing `MoveTaskToStage` use case to interpret it as "task not found" and throw `TaskNotFoundError`. The route handler would return 404 `TASK_NOT_FOUND` when the actual problem is 404 `STAGE_NOT_FOUND`. This is misleading to clients.

The same catch-all pattern exists in `updateTask` and `deleteTask` (pre-existing), but in `moveTaskToStage` it creates a misleading error category since the stage lookup is supposed to happen in the use case, not the repository.

---

## SUGGESTION findings (nice to have)

### 1. [scheduling.routes.ts] No `StageNotFoundError` handler in `PUT /:id` for `stageId` validation

REQ-UPDATE-4 requires that a non-existent `stageId` in `PUT /api/scheduling/:id` returns 404 `STAGE_NOT_FOUND`. The current `updateTask` use case calls `repo.updateTask()` directly without validating that `stageId` points to a real Stage. The route handler catches no `StageNotFoundError`. This is partially mitigated by the DB FK constraint, but the error surface would be a 500 rather than a 404.

### 2. [seed.ts] Workflow upsert keyed by `id` rather than `name`

The seed uses a hardcoded UUID for the workflow ID (`wf-default-00000000-0000-0000-0000-000000000001`) and upserts by `id`. This works but diverges from the `spec.md` REQ-WF-SEED-2 requirement that the seed use `upsert` keyed by `name`. If the migration bootstraps a workflow with a different generated UUID (which it does — `gen_random_uuid()::text`), the seed will create a SECOND "Default" workflow if the upsert-by-id finds no match with that specific ID. The `ON CONFLICT (LOWER("name"))` unique index will catch this with a DB error, but the seed error handler silently swallows it:

```ts
try {
  await seedSchedulingFoundation()
} catch (err) {
  console.warn('Could not seed scheduling foundation ...')
}
```

The seed should upsert by name, not by ID, to be truly idempotent across environments where the migration and the seed may have created workflows with different IDs.

### 3. [workflows.routes.ts] `GET /project-categories/:id` and `GET /project-types/:id` are implemented but not listed in the spec routes table

The spec `scheduling-workflows/spec.md` top-level routes table does not list `GET /api/scheduling/project-categories/:id` or `GET /api/scheduling/project-types/:id` individually, though they are implied by the CRUD wording. They are implemented and correct. This is just a spec documentation gap.

### 4. [PrismaWorkflowRepository.ts:63] `category as any` cast

`PrismaWorkflowRepository.create()` and `PrismaStageRepository.add()` cast `category` as `any` when creating stages. This is required because the Prisma client's `StageCategory` enum type is generated from the schema, and the TypeScript string-literal union from `@domain/entities/workflow` doesn't unify with it. After `prisma generate`, an explicit mapping (e.g. a `toDbCategory()` helper) would be cleaner than `as any`.

---

## Spec REQ coverage matrix

### scheduling/spec.md delta REQs

| REQ-ID | Status | Test file | Implementation file |
|--------|--------|-----------|---------------------|
| REQ-CREATE-1 (modified — stageId optional) | ✅ | scheduling.routes.test.ts | scheduling.routes.ts:54-97 |
| REQ-CREATE-4 (modified — stageId 404) | ✅ | scheduling.routes.test.ts | scheduling.routes.ts:91-93 |
| REQ-UPDATE-4 (modified — stageId 404) | ⚠️ PARTIAL | scheduling.routes.test.ts | PUT handler has no StageNotFoundError catch |
| REQ-SHAPE-2 (modified — stageId+stageCategory+status) | ✅ | scheduling.routes.test.ts | PrismaSchedulingRepository.ts:toTask() |
| REQ-VAL-1 (modified — stageId optional, no status) | ✅ | scheduling.routes.test.ts | scheduling.dto.ts |
| REQ-VAL-2 (modified — UpdateTaskSchema partial) | ✅ | scheduling.routes.test.ts | scheduling.dto.ts |
| REQ-STAGE-1 (move to stage 200) | ✅ | scheduling.routes.test.ts | scheduling.routes.ts:114-134 |
| REQ-STAGE-2 (non-existent stageId 404) | ✅ | scheduling.routes.test.ts | scheduling.routes.ts:123-126 |
| REQ-STAGE-3 (missing/malformed stageId 400) | ✅ | scheduling.routes.test.ts | MoveStageSchema |
| REQ-STAGE-4 (task not found 404) | ✅ | scheduling.routes.test.ts | scheduling.routes.ts:127-130 |
| REQ-STAGE-CATEGORY-1 (stageCategory derived) | ✅ | scheduling.routes.test.ts | PrismaSchedulingRepository.ts:toTask() |
| REQ-STAGE-COMPLETED-1 (auto-set completedAt on hecho) | ✅ | WorkflowUseCases.test.ts | InMemorySchedulingRepository + PrismaSchedulingRepository |
| REQ-STAGE-COMPLETED-2 (no overwrite of completedAt) | ✅ | WorkflowUseCases.test.ts | InMemorySchedulingRepository.ts:257-259 |
| REQ-STAGE-PROJECTNAME-1 (projectName in response) | ✅ | scheduling.routes.test.ts | PrismaSchedulingRepository.ts:toTask() |
| REQ-STAGE-DEFAULT-1 (default to first Nuevo stage) | ❌ CRITICAL | — | BROKEN in production (see Critical #1) |
| REQ-STAGE-DEP-1 (deprecated /status works) | ✅ | scheduling.routes.test.ts | scheduling.routes.ts:137-150 |
| REQ-STAGE-DEP-2 (deprecated route logs warning) | ✅ | scheduling.routes.test.ts | scheduling.routes.ts:138 |
| REQ-STAGE-DEP-3 (deprecated status field in responses) | ✅ | scheduling.routes.test.ts | PrismaSchedulingRepository.ts:deriveLegacyStatus() |

### scheduling-workflows/spec.md REQs

| REQ-ID | Status | Test file | Implementation file |
|--------|--------|-----------|---------------------|
| REQ-WF-AUTH-1 | ✅ | workflows.routes.test.ts | workflows.routes.ts (auth on every route) |
| REQ-WF-AUTH-2 | ✅ | workflows.routes.test.ts | workflows.routes.ts |
| REQ-WF-AUTH-3 | ✅ | workflows.routes.test.ts | FakeAuthProvider pattern |
| REQ-WF-LIST-1 | ✅ | workflows.routes.test.ts | ListWorkflows + PrismaWorkflowRepository |
| REQ-WF-LIST-2 | ⚠️ DEFERRED | — | Requires real seeded DB (no integration test) |
| REQ-WF-GET-1 | ✅ | workflows.routes.test.ts | GetWorkflow |
| REQ-WF-GET-2 | ✅ | workflows.routes.test.ts | GetWorkflow + WorkflowNotFoundError |
| REQ-WF-CREATE-1 | ✅ | workflows.routes.test.ts | CreateWorkflow |
| REQ-WF-CREATE-2 | ✅ | workflows.routes.test.ts | CreateWorkflowSchema |
| REQ-WF-CREATE-3 | ✅ | workflows.routes.test.ts | StageCategorySchema |
| REQ-WF-CREATE-4 | ✅ | workflows.routes.test.ts | WorkflowNameConflictError |
| REQ-WF-CREATE-5 | ✅ | workflows.routes.test.ts | CreateWorkflow |
| REQ-WF-UPDATE-1 | ✅ | workflows.routes.test.ts | UpdateWorkflow |
| REQ-WF-UPDATE-2 | ✅ | workflows.routes.test.ts | WorkflowNotFoundError |
| REQ-WF-UPDATE-3 | ✅ | workflows.routes.test.ts | WorkflowNameConflictError |
| REQ-WF-DELETE-1 | ✅ | workflows.routes.test.ts | DeleteWorkflow |
| REQ-WF-DELETE-2 | ✅ | workflows.routes.test.ts | WorkflowNotFoundError |
| REQ-WF-DELETE-3 | ✅ | workflows.routes.test.ts | WorkflowInUseError + taskCount |
| REQ-WF-DELETE-4 | ✅ | workflows.routes.test.ts | DefaultWorkflowProtectedError |
| REQ-STAGE-ADD-1 | ✅ | workflows.routes.test.ts | AddStageToWorkflow |
| REQ-STAGE-ADD-2 | ✅ | workflows.routes.test.ts | CreateStageSchema |
| REQ-STAGE-ADD-3 | ✅ | workflows.routes.test.ts | WorkflowNotFoundError |
| REQ-STAGE-ADD-4 | ✅ | workflows.routes.test.ts | StageNameConflictError |
| REQ-STAGE-REORDER-1 | ✅ | workflows.routes.test.ts | ReorderStages |
| REQ-STAGE-REORDER-2 | ✅ | workflows.routes.test.ts | ReorderSetMismatchError |
| REQ-STAGE-REORDER-3 | ✅ | workflows.routes.test.ts | WorkflowNotFoundError |
| REQ-STAGE-DELETE-1 | ✅ | workflows.routes.test.ts | RemoveStageFromWorkflow |
| REQ-STAGE-DELETE-2 | ✅ | workflows.routes.test.ts | StageInUseError + taskCount |
| REQ-STAGE-DELETE-3 | ✅ | workflows.routes.test.ts | StageNotFoundError |
| REQ-WF-SEED-1 | ⚠️ DEFERRED | — | No DB integration test; seed content verified by inspection |
| REQ-WF-SEED-2 | ⚠️ PARTIAL | — | Seed is idempotent by design but upserts by ID not by name (see Suggestion #2) |
| REQ-PC-LIST-1 | ✅ | workflows.routes.test.ts | ListProjectCategory |
| REQ-PC-CREATE-1 | ✅ | workflows.routes.test.ts | CreateProjectCategory |
| REQ-PC-CREATE-2 | ✅ | workflows.routes.test.ts | ProjectCategoryNameConflictError |
| REQ-PC-UPDATE-1 | ✅ | workflows.routes.test.ts | UpdateProjectCategory |
| REQ-PC-DELETE-1 | ✅ | workflows.routes.test.ts | DeleteProjectCategory |
| REQ-PC-VALIDATION-1 | ✅ | workflows.routes.test.ts | CreateProjectCategorySchema |
| REQ-PT-LIST-1 | ✅ | workflows.routes.test.ts | ListProjectType |
| REQ-PT-CREATE-1 | ✅ | workflows.routes.test.ts | CreateProjectType |
| REQ-PT-CREATE-2 | ✅ | workflows.routes.test.ts | ProjectTypeNameConflictError |
| REQ-PT-UPDATE-1 | ✅ | workflows.routes.test.ts | UpdateProjectType |
| REQ-PT-DELETE-1 | ✅ | workflows.routes.test.ts | DeleteProjectType |
| REQ-PT-VALIDATION-1 | ✅ | workflows.routes.test.ts | CreateProjectTypeSchema |
| REQ-WF-SHAPE-1 | ✅ | workflows.routes.test.ts | PrismaWorkflowRepository.toWorkflow() |
| REQ-WF-SHAPE-2 | ✅ | workflows.routes.test.ts | PrismaStageRepository.toStage() |
| REQ-WF-VAL-1 | ✅ | workflows.dto.test.ts | CreateWorkflowSchema |
| REQ-WF-VAL-2 | ✅ | workflows.dto.test.ts | CreateStageSchema |
| REQ-WF-VAL-3 | ✅ | workflows.dto.test.ts | UpdateWorkflowSchema |
| REQ-WF-VAL-4 | ✅ | workflows.dto.test.ts | ReorderStagesSchema |
| REQ-WF-DIP-1 | ✅ | tsc --noEmit | No @infrastructure/* in application/ |
| REQ-WF-DIP-2 | ✅ | — | createWorkflowsRouter accepts authProvider as param |

---

## Open items deferred to apply phase of later changes

- **Prisma integration tests for `PrismaWorkflowRepository`, `PrismaStageRepository`, `PrismaProjectCategoryRepository`, `PrismaProjectTypeRepository`, `PrismaSchedulingRepository`** — skipped due to no test DB accessible during apply. Required before production deploy.
- **Manual sanity check** (tasks.md 9.3) — skipped, no local Postgres available. Required.
- **REQ-WF-LIST-2** (Default workflow appears first with 11 stages) — requires real seeded DB. Deferred to integration test.
- **REQ-UPDATE-4 full coverage** — `PUT /:id` with non-existent `stageId` will produce 500 (Prisma FK violation caught as null then 404), not the spec-required 404 `STAGE_NOT_FOUND`. This is a gap in the route handler.

---

## Recommendation

**FIX-CRITICAL-FIRST**

The `POST /api/scheduling` without `stageId` will crash in production with a FK violation due to the sentinel ID. This must be fixed before deployment. The fix is contained to `scheduling.routes.ts` and `app.ts` (add `StageRepository` param to `createSchedulingRouter`). All other findings are warnings or suggestions that do not block correctness for callers who always supply `stageId`.

The schema drift (`stageId String?` in Prisma vs `NOT NULL` in the DB) should also be fixed in the same commit as the critical fix by changing the schema and re-running `prisma generate`.
