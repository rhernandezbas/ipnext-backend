# Proposal: Scheduling Foundation — Stage Model

## Intent

The current `ScheduledTask.status` is a free `String` column with four hardcoded values (`pending | in_progress | completed | cancelled`) and the `Project` model is reduced to `title + description`. Splynx (the system we are replicating) drives the entire scheduling UI off a **configurable Workflow + Stage** model where each Project picks a Workflow, and each Stage belongs to one of three visual categories (`Nuevo`, `En progreso`, `Hecho`). The list of sub-stages (Nuevo, Confirmado, Pospuesta, No Factible, Enviar a IClass, Registrado en IClass, Notificado, En progreso, Instalado, Hecho, Anulado-Cancelado) is configurable per workflow, not enum-locked.

This change is the **foundation** for the 6-change Splynx scheduling replica plan (`md/splynx-scheduling/OVERVIEW.md`). It introduces the `Workflow`, `Stage`, `ProjectCategory`, and `ProjectType` domain models, migrates the existing task data from `status: String` to `stageId: FK Stage`, ships a backend-only admin HTTP capability to manage Workflows and Stages, and rewires the existing `PATCH /:id/status` flow onto the stage model with a deprecation window. All subsequent changes (project enrichment, task enrichment, Kanban view, etc.) depend on this one.

## Scope

### In Scope
- Prisma models `Workflow`, `Stage`, `ProjectCategory`, `ProjectType`
- Single Prisma migration: schema additions + data migration (`status` → `stageId`)
- Seed extension in `prisma/seed.ts` creating the "Default" workflow with the 11 Splynx sub-stages, plus a "Legacy" workflow used only as a safety net for unmappable rows
- New FK column `ScheduledTask.stageId` (NOT NULL after data migration); legacy `status` column kept for **one release** (dual-read, dual-write disabled) and dropped in the next change — flagged with rationale below
- Domain entities `Workflow`, `Stage`, `ProjectCategory`, `ProjectType` under `src/domain/entities/`
- Ports `WorkflowRepository`, `StageRepository`, `ProjectCategoryRepository`, `ProjectTypeRepository` under `src/domain/ports/`
- Prisma adapters with **coherent naming** (file name matches exported class — do NOT replicate the `InMemory*` debt described in `openspec/config.yaml#known_debt.naming-mismatch`)
- In-memory adapters for TDD (`InMemoryWorkflowRepository`, etc.) in `src/infrastructure/adapters/in-memory/`
- Use cases: `ListWorkflows`, `GetWorkflow`, `CreateWorkflow`, `UpdateWorkflow`, `DeleteWorkflow`, `ReorderStages`, `AddStageToWorkflow`, `RemoveStageFromWorkflow`, plus CRUD use cases for `ProjectCategory` and `ProjectType`
- Update `ScheduledTask` domain entity: replace `status: TaskStatus` with `stageId: string` plus a **read-only derived** field `stageCategory: 'nuevo' | 'enProgreso' | 'hecho'` resolved by the repository at query time
- Update `SchedulingRepository` port: add `moveTaskToStage(id, stageId)`; keep `updateTaskStatus(id, status)` as a **thin shim** that resolves the legacy status string against the Default workflow and forwards to `moveTaskToStage`
- DTO changes in `src/application/dto/scheduling.dto.ts`: introduce `MoveStageSchema { stageId: string }`; `CreateTaskSchema` and `UpdateTaskSchema` swap `status` for optional `stageId` (defaults to the Default workflow's first Nuevo stage when omitted on create); the old `UpdateStatusSchema` is retained but marked `@deprecated`
- New router `createWorkflowsRouter` mounted at `/api/scheduling/workflows` with auth on every route
- `PATCH /api/scheduling/:id/stage` (new) coexists with `PATCH /api/scheduling/:id/status` (deprecated, logs warning, internally calls `moveTaskToStage`)
- Wire all new use cases / repos into `app.ts` — flagged below

### Out of Scope (deferred to later changes)
- Enriching `Project` with `workflowId`, `categoryId`, `typeId`, `partners`, `projectLeadId`, `visible` → change `scheduling-projects-enrich`
- `scheduledDate/Time: String` → `startDate/endDate: DateTime` migration → change `scheduling-tasks-enrich`
- Adding `customerId`, `serviceId`, `partnerId`, `reporterId`, `watchers`, `travelTimeTo/From`, rich-text description → change `scheduling-tasks-enrich`
- Task detail page → change `scheduling-task-detail-page`
- ChecklistTemplate items + TaskChecklistItem → change `scheduling-checklists`
- Kanban view + auth fix on `projects.routes.ts` → change `scheduling-tasks-views`
- Admin **frontend** page for workflow management (`/admin/scheduling/config/workflows` with `impeccable` skill) — deferred to a follow-up frontend change. This change ships backend only.
- Dropping the legacy `ScheduledTask.status` column — deferred to next change after one release of dual-presence

## Capabilities

### New Capabilities
- `scheduling-workflows`: Full HTTP capability for Workflow + Stage admin (CRUD, reorder), plus ProjectCategory + ProjectType CRUD. New spec file `openspec/specs/scheduling-workflows/spec.md`.

### Modified Capabilities
- `scheduling`: status-based requirements (REQ-STATUS-1..7, REQ-VAL-1..3, REQ-SHAPE-2 row for `status`) replaced by stage-based equivalents. Delta documented in `specs/scheduling/spec.md`.

## Approach

1. **Schema**: extend `prisma/schema.prisma` with `Workflow`, `Stage`, `ProjectCategory`, `ProjectType`; add `stageId String?` (initially nullable) to `ScheduledTask`. Run `npm run prisma:migrate -- --name scheduling_foundation_stage_model`.
2. **Seed**: in `prisma/seed.ts`, upsert one Workflow `"Default"` with 11 Stages in the documented order and categories (see Design §Migration); upsert `"Default Category"` ProjectCategory and `"Instalacion"` ProjectType for forward compatibility.
3. **Data migration**: a follow-up SQL statement inside the same Prisma migration body backfills `stageId` for every `ScheduledTask` row by mapping `status` → Stage in the Default workflow (`pending → Nuevo`, `in_progress → En progreso`, `completed → Hecho`, `cancelled → Anulado-Cancelado`). After backfill, alter `stageId` to NOT NULL.
4. **Domain + ports**: write entities and ports (red-first tests in the apply phase).
5. **Adapters**: Prisma + in-memory implementations, coherent naming. Repository `findById` for `ScheduledTask` joins `Stage` and projects `stageCategory` from `Stage.category`.
6. **Use cases**: CRUD use cases for Workflow/Stage/ProjectCategory/ProjectType. `ReorderStages` takes `{ workflowId, order: string[] }` (ordered list of stage IDs).
7. **DTOs**: zod schemas in `src/application/dto/workflows.dto.ts` (new file) and updates to `scheduling.dto.ts`.
8. **Routes**: new `workflows.routes.ts`; modify `scheduling.routes.ts` to expose `PATCH /:id/stage` (new) and keep `PATCH /:id/status` as a deprecated alias.
9. **Wire** everything in `app.ts` (flagged below).
10. **Tests**: strict TDD throughout — schemas, use cases (in-memory port), routes (supertest).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modified | 4 new models + new column `ScheduledTask.stageId` |
| `prisma/migrations/<ts>_scheduling_foundation_stage_model/` | New | DDL + data migration backfill |
| `prisma/seed.ts` | Modified | Seed Default workflow with 11 stages + Default ProjectCategory + Instalacion ProjectType |
| `src/domain/entities/scheduling.ts` | Modified | Replace `status: TaskStatus` with `stageId: string` + add `stageCategory: 'nuevo'\|'enProgreso'\|'hecho'` (read-only) |
| `src/domain/entities/workflow.ts` | New | `Workflow`, `Stage`, `StageCategory` types |
| `src/domain/entities/projectCategory.ts` | New | `ProjectCategory` type |
| `src/domain/entities/projectType.ts` | New | `ProjectType` type |
| `src/domain/ports/WorkflowRepository.ts` | New | CRUD + `reorderStages` |
| `src/domain/ports/StageRepository.ts` | New | List by workflow, add/remove |
| `src/domain/ports/ProjectCategoryRepository.ts` | New | CRUD |
| `src/domain/ports/ProjectTypeRepository.ts` | New | CRUD |
| `src/domain/ports/SchedulingRepository.ts` | Modified | Add `moveTaskToStage`; `updateTaskStatus` becomes shim |
| `src/infrastructure/adapters/prisma/PrismaWorkflowRepository.ts` | New | Class name MUST match file name |
| `src/infrastructure/adapters/prisma/PrismaStageRepository.ts` | New | idem |
| `src/infrastructure/adapters/prisma/PrismaProjectCategoryRepository.ts` | New | idem |
| `src/infrastructure/adapters/prisma/PrismaProjectTypeRepository.ts` | New | idem |
| `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts` | Modified | Join `Stage`, derive `stageCategory`, implement `moveTaskToStage`, shim `updateTaskStatus` |
| `src/infrastructure/adapters/in-memory/InMemory{Workflow,Stage,ProjectCategory,ProjectType}Repository.ts` | New | 4 files |
| `src/application/use-cases/{ListWorkflows,GetWorkflow,CreateWorkflow,UpdateWorkflow,DeleteWorkflow,AddStageToWorkflow,RemoveStageFromWorkflow,ReorderStages}.ts` | New | 8 files |
| `src/application/use-cases/{List,Get,Create,Update,Delete}{ProjectCategory,ProjectType}.ts` | New | 10 files |
| `src/application/use-cases/MoveTaskToStage.ts` | New | Replaces conceptually `UpdateTaskStatus`; latter kept as deprecated alias |
| `src/application/dto/workflows.dto.ts` | New | Zod schemas: `CreateWorkflowSchema`, `UpdateWorkflowSchema`, `CreateStageSchema`, `ReorderStagesSchema`, `CreateProjectCategorySchema`, `CreateProjectTypeSchema`, partials for updates |
| `src/application/dto/scheduling.dto.ts` | Modified | Introduce `MoveStageSchema`; mark `TaskStatusSchema` and `UpdateStatusSchema` `@deprecated`; swap `status` → optional `stageId` in `CreateTaskSchema`/`UpdateTaskSchema` |
| `src/infrastructure/http/routes/workflows.routes.ts` | New | 8 routes, auth on every one |
| `src/infrastructure/http/routes/scheduling.routes.ts` | Modified | Add `PATCH /:id/stage`; keep `PATCH /:id/status` as deprecated alias |
| `src/infrastructure/http/app.ts` | Modified | Wire 4 new repos + 18 new use cases + new router — **flagged: touches god object** |
| `src/__tests__/**` | New + modified | TDD coverage; details in design + tasks |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Data migration corrupts existing tasks if a `status` value is unexpected | Medium | Migration uses explicit `CASE` mapping; fallback maps any unknown value to the Default workflow's `Nuevo` stage and logs a notice; no row is left with `stageId IS NULL` |
| Frontend breaks because the response field name changes from `status` to `stageId` | High | Response body keeps `status` for **one release** as a derived alias (`stageCategory`); frontend coordination section below documents the timeline |
| Touches `app.ts` god object | Medium | Justified — this is foundational wiring (4 repos + 18 use cases + 1 router) that downstream changes will rely on. Concentrating the churn in one PR avoids 6 follow-up `app.ts` edits. The god-object refactor is its own deferred change (`known_debt.god-object-app`). |
| Existing scheduling tests reference `status` enum values | High | Update tests in the same change (TDD — adjust expectations, swap to `stageId` + `stageCategory` assertions; cover deprecation alias) |
| Naming debt accidentally propagated to new adapters | Medium | Proposal + design explicitly call out: file name MUST match class name. Verify before commit. |
| Rollback after migration is non-trivial (DDL + data) | Medium | See Rollback Plan — `down` migration is shipped alongside `up`; data backfill is reversible because `status` column is retained for one release |
| Deprecation shim `updateTaskStatus` confuses developers | Low | JSDoc `@deprecated`, log warning on call, design doc cites timeline |

## Frontend Coordination (NOT part of this change)

Frontend team must (in a coordinated PR merged within the same release window):

- Treat `ScheduledTask.status` as **deprecated** (still returned for backward compatibility). New code SHOULD read `stageCategory` for the three-bucket grouping and `stageId` for the specific sub-stage.
- Update `ipnext-frontend/src/types/scheduling.ts` to add `stageId: string` and `stageCategory: 'nuevo' | 'enProgreso' | 'hecho'`; mark `status` as `/** @deprecated use stageCategory */`.
- `useTasks` and `useProjects` hooks: no URL changes. The PATCH endpoint to use moving forward is `/api/scheduling/:id/stage` with `{ stageId }`. The old `/api/scheduling/:id/status` with `{ status }` keeps working through the next release.
- Admin UI for workflow management is **out of scope** for this change. A follow-up frontend change will build it with `impeccable` applied.

## Rollback Plan

This change ships a Prisma migration with both schema DDL and a data backfill, so rollback is non-trivial. Strategy:

1. **Pre-merge safety net**: tag the commit immediately before merge (`pre-stage-model`). The PR is single-commit on backend; revert = one `git revert`.
2. **DB rollback path A — within the release**: the migration's `down` SQL is shipped alongside `up` (Prisma generates it; verified during design). Steps:
   - Run `prisma migrate resolve --rolled-back <migration-name>` or manually apply the down SQL.
   - Down SQL drops `stageId` FK + new tables. **Existing data is preserved** because `status` column was kept (this is precisely why it is retained for one release).
3. **DB rollback path B — after `status` column is dropped (next change)**: this change's rollback no longer reaches that state, but flag for the next change: dropping `status` requires a separate, explicit rollback story (likely a `status` shadow column populated from `stageCategory` before the drop).
4. **App rollback**: `git revert` of the merge commit restores the old code. The reverted app will read `status` from the DB normally because the column was retained.
5. **Frontend**: no rollback needed — frontend continues reading `status` (still present). If frontend already shipped the `stageId/stageCategory` consumer, it falls back to `status` (types must be defensive).

If the migration succeeded but the application code is broken in production, the safest order is: revert the app deploy first, then leave the DB as-is (the new columns/tables sit idle without breaking the reverted app — the old `status` column is intact).

## Dependencies

- No new npm packages. Uses existing `zod`, `prisma`, `@prisma/client`, `@prisma/adapter-pg`.
- Strictly Postgres-driven. **No new Splynx API calls** — `md/splynx-scheduling/snapshots/*.yml` is reference data only (Splynx is being deprecated).
- Blocks: `scheduling-projects-enrich`, `scheduling-tasks-enrich`, `scheduling-tasks-views`. None of them can start until this is merged and migrated in all environments.

## Success Criteria

- [ ] Prisma migration applies cleanly on a fresh DB and on a DB pre-populated with `ScheduledTask` rows under the old `status` enum
- [ ] After migration, every `ScheduledTask` row has a non-null `stageId` pointing into the Default workflow
- [ ] `npm run prisma:seed` is idempotent (re-run safe)
- [ ] `GET /api/scheduling/workflows` returns the Default workflow with 11 stages in the documented order, grouped by category
- [ ] CRUD use cases for Workflow, Stage, ProjectCategory, ProjectType pass unit tests against in-memory ports
- [ ] `PATCH /api/scheduling/:id/stage` updates `stageId` and the response carries the correct `stageCategory`
- [ ] `PATCH /api/scheduling/:id/status` still works (deprecation alias) and produces the same end result as `/stage`
- [ ] `GET /api/scheduling/:id` response includes both `stageId`, `stageCategory`, and the deprecated `status`
- [ ] All new Prisma adapter files export a class whose name matches the file name (no `InMemory*` debt propagation)
- [ ] `npm test` green; `tsc --noEmit` clean
- [ ] No use-case imports from `@infrastructure/*` (DIP preserved)
- [ ] `app.ts` change is reviewable in isolation (≤ ~30 lines added; only wiring, no logic)
