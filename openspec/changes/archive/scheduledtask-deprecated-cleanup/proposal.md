# Proposal — scheduledtask-deprecated-cleanup

## Intent

The `ScheduledTask` model (`prisma/schema.prisma:545`) carries six deprecated columns that have lived alongside their replacements for several releases. They are the residue of three half-finished migrations:

- `status` (String) → `stageId` FK (`scheduling-foundation-stage-model`)
- `scheduledDate` / `scheduledTime` (String) → `startDate` / `endDate` (DateTime) (`scheduling-tasks-enrich`)
- `clientId` / `clientName` (String) → `customerId` FK + JOIN-derived `customerName`
- `assignedTo` / `assignedToId` (String) → `assigneeId` FK + JOIN-derived `assigneeName`

Each was annotated `@deprecated ... will be removed in cleanup change`. This is that change. The goal is the SAFE removal of the deprecated columns and their supporting code, using an expand/contract strategy so PROD data (5589 clients, active tasks already referencing `customerId`) and the frontend never break.

This is a backend-led debt-paydown change with a coordinated frontend follow-up — analogous to the lockstep model used in `scheduling-checklists`.

## Problem

1. **Schema noise & drift risk**: the model declares two parallel sets of fields for the same concept. New code can accidentally read the stale one.
2. **Live fallback reads still cited as load-bearing**: `PrismaSchedulingRepository.toTask` derives `customerName` and `assigneeName` with a fallback to the legacy columns (`row.customer?.name ?? row.clientName`, `row.assignee?.name ?? row.assignedTo`). Removing the columns without a backfill would silently drop names for any row whose new FK is still null.
3. **Deprecated write paths**: `CreateTask` / `UpdateTask` (route + both adapters) still persist `assignedTo`, `clientId`, `scheduledDate`, etc. As long as those are accepted, new rows keep populating dead columns.
4. **Deprecated route & use case**: `PATCH /api/scheduling/:id/status` + `UpdateTaskStatus` shim are still mounted.
5. **Frontend coupling**: the frontend `ScheduledTask` type and several components STILL read the legacy fields as fallbacks (see Risks). A naive column drop would 500 nothing but would surface blank names / wrong calendar dates.

## Scope IN

Deprecated `ScheduledTask` fields targeted for removal (per `schema.prisma`):

| Field | Replacement | Backfill needed? |
|-------|-------------|------------------|
| `status` | `stageId` (FK) — `status` is now **derived** read-only via `deriveLegacyStatus` | NO — `stageId` already backfilled & NOT NULL |
| `scheduledDate` | `startDate` | Already backfilled by `scheduling-tasks-enrich` DO-block. **Re-verify coverage** before drop |
| `scheduledTime` | `startDate`/`endDate` | Same as above |
| `clientId` | `customerId` (FK) | **YES — no backfill exists yet** |
| `clientName` | `customerName` (JOIN-derived) | Captured by `customerId` backfill (name comes from JOIN) |
| `assignedTo` | `assigneeId` (FK) + `assigneeName` (JOIN) | **Risky — see design.** `assignedTo` is free text, may not map to an Admin |
| `assignedToId` | `assigneeId` (FK) | **YES — no backfill exists yet** |

Backend artifacts in scope:
- `prisma/schema.prisma` — drop 6 columns + 2 stale indexes (`@@index([status])`, `@@index([scheduledDate])`).
- New Prisma migration(s) — backfill + contract DDL (hand-written SQL; applied via `migrate deploy` on container start).
- `src/domain/entities/scheduling.ts` — remove deprecated fields from `ScheduledTask` and the `TaskStatus` type/`status` field.
- `src/application/dto/scheduling.dto.ts` — remove deprecated input fields, `TaskStatusSchema`, `UpdateStatusSchema`.
- `src/application/use-cases/UpdateTaskStatus.ts` — delete (shim).
- `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts` — drop fallback reads, `deriveLegacyStatus`, legacy write mappings.
- `src/infrastructure/adapters/in-memory/InMemorySchedulingRepository.ts` — same.
- `src/infrastructure/http/routes/scheduling.routes.ts` — remove `PATCH /:id/status` route and legacy field mapping in create/update.
- `src/infrastructure/http/app.ts` — drop `UpdateTaskStatus` wiring ⚠ (God Object file — flagged).
- Tests under `src/__tests__/` — adapt the ~136 references to deprecated fields across the 4 scheduling test files.

## Scope OUT

- Frontend implementation (lives in sibling `ipnext-frontend`). This proposal only **specifies the coordination contract**; the frontend PR is tracked separately and must land per the rollout order in `design.md`.
- Removing deprecation on OTHER models (priority enum, category enum, `TaskStatusSchema` reuse elsewhere — none found).
- Renaming `customerId`→`clientId` or any "rename to the nicer name" cosmetic churn. The new names stay.
- Splynx changes (constraint: no new Splynx dependencies).

## Approach (high level)

Expand/contract, executed in ordered phases so each deploy is independently safe:

1. **Verify + Backfill (expand-complete)**: a forward-only migration that backfills `customerId`/`assigneeId` from the legacy columns where the new FK is null, after auditing how many rows are affected. Confirm `startDate` coverage (already backfilled) and `stageId` (already NOT NULL).
2. **Stop writing the legacy columns**: remove legacy fields from DTO + adapters + routes so no new row populates them. Keep reading the fallback for one release. Deploy.
3. **Stop reading the legacy columns**: drop `deriveLegacyStatus`, the `clientName`/`assignedTo` fallbacks, and the `status` field from the DTO/entity. Coordinate frontend to stop reading them in the SAME release window.
4. **Drop the columns (contract)**: migration that `DROP COLUMN`s the six fields + 2 indexes. Deploy.

## Risks

1. **No backfill for `customerId`/`assigneeId`** — dropping `clientId`/`assignedToId` first would orphan any task whose new FK was never set. Mitigation: audit + backfill migration in Phase 1, gated on a row-count check.
2. **`assignedTo` is free text, not an FK** — it may hold names that don't resolve to an `Admin`. Backfilling `assigneeId` from it is best-effort; unmatched values are LOST on drop. Mitigation: design documents a name→Admin match attempt, logs unmatched rows via `RAISE NOTICE`, and treats `assigneeName` continuity as accepted loss for unmatched free-text values.
3. **Frontend still reads legacy fields** — `SchedulingDashboardPage` (`status`, `scheduledDate`), `SchedulingCalendarPage` (`scheduledDate`/`scheduledTime`/`clientName`), `KanbanCard` (`clientName`). Mitigation: lockstep rollout — frontend stops reading legacy fields BEFORE backend drops them.
4. **`status` is consumed for filtering/metrics in FE dashboard** — it is derived, not stored, so it survives until we remove it from the DTO. Removing it requires the FE to switch to `stageCategory`. Mitigation: covered in the frontend contract; `stageCategory` already exposed.
5. **`onDelete` behavior** — `customerId`/`assigneeId` FKs are `ON DELETE SET NULL`; the legacy string columns have no such protection. After contraction, deleting a Client nulls `customerId` (and thus `customerName` via JOIN) — acceptable and already the live behavior.
6. **`app.ts` edit** — removing `UpdateTaskStatus` wiring touches the 617-line God Object. Mitigation: surgical single-block removal, covered by composition test.
7. **Migration applied via `migrate deploy` on container boot** — a slow backfill on a large table blocks startup. Mitigation: backfill is a bounded single UPDATE with a WHERE guard; `ScheduledTask` is small relative to clients.

## Rollback Plan

- Phases 1–3 are code-level / additive-data and revert by reverting the merge commit; the backfill is idempotent and harmless if re-run.
- Phase 4 (DROP COLUMN) is the only destructive step. Down SQL re-adds the columns as nullable (data is NOT recoverable, but schema is). Documented in `design.md`. Recommendation: take a DB snapshot before applying Phase 4 in PROD.

## Affected Areas

### Backend
- `prisma/schema.prisma`
- `prisma/migrations/<ts>_scheduledtask_backfill_fks/migration.sql` (new — Phase 1)
- `prisma/migrations/<ts>_scheduledtask_drop_deprecated/migration.sql` (new — Phase 4)
- `src/domain/entities/scheduling.ts`
- `src/application/dto/scheduling.dto.ts`
- `src/application/use-cases/UpdateTaskStatus.ts` (delete)
- `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts`
- `src/infrastructure/adapters/in-memory/InMemorySchedulingRepository.ts`
- `src/infrastructure/http/routes/scheduling.routes.ts`
- `src/infrastructure/http/app.ts` ⚠
- `src/__tests__/infrastructure/scheduling.routes.test.ts`, `scheduling.routes.filter.test.ts`, `scheduling-composition.test.ts`, `src/__tests__/application/dto/scheduling.dto.test.ts`

### Frontend (sibling repo — coordination only)
- `src/types/scheduling.ts` (remove legacy fields)
- `src/pages/scheduling/SchedulingDashboardPage.tsx` (`status` → `stageCategory`, `scheduledDate` → `startDate`)
- `src/pages/scheduling/SchedulingCalendarPage/index.tsx` (drop `scheduledDate`/`scheduledTime`/`clientName` fallbacks)
- `src/pages/scheduling/SchedulingTasksPage/components/KanbanCard.tsx` (drop `clientName` fallback)
- `src/api/scheduling.api.ts`

## Success Criteria

- Phase 1 audit shows 0 tasks left with a populated legacy FK column but a null new FK after backfill.
- `npm test` green (Jest) and `tsc --noEmit` green after each phase.
- Composition test confirms `PATCH /:id/status` is gone (404, not shadowing `/:id`).
- After Phase 4, `schema.prisma` `ScheduledTask` has zero `@deprecated` annotations.
- No blank `customerName`/`assigneeName` in the Tasks list for rows that previously had legacy data.
- Frontend renders Dashboard, Calendar, Kanban with no reference to removed fields.
