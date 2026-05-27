# Tasks — scheduledtask-deprecated-cleanup

Expand/contract. Each phase is independently deployable. Phase 4 (destructive DROP) ships strictly AFTER the frontend stop-read PR is live. STRICT TDD: failing test first, then implementation.

## Phase 0 — Audit (no code change)

- [ ] 0.1 Run a read-only query against a PROD snapshot: count rows where `customerId IS NULL AND clientId IS NOT NULL`; where `assigneeId IS NULL AND (assignedToId IS NOT NULL OR assignedTo IS NOT NULL)`; where `startDate IS NULL AND scheduledDate IS NOT NULL`. Record the numbers in the change notes.
- [ ] 0.2 Confirm no external/third-party caller hits `PATCH /api/scheduling/:id/status` (check logs for the existing deprecation warning; grep frontend — already verified none).
- [ ] 0.3 Verify `stageId` is NOT NULL for all rows (it was made NOT NULL in `scheduling-foundation-stage-model`). Sanity only.

## Phase 1 — Complete the expand (backfill FKs) — depends on Phase 0

- [ ] 1.1 (TEST) Write an integration test that seeds a task with only `clientId` (valid Client), one with a dangling `clientId`, and one with `assignedTo` matching an Admin name; asserts the backfill populates `customerId`/`assigneeId` correctly and leaves the dangling one null.
- [ ] 1.2 Create migration dir `prisma/migrations/<ts>_scheduledtask_backfill_fks/` with hand-written `migration.sql` (the 3 guarded UPDATEs + audit DO-block from `design.md`). No schema.prisma change (additive data only).
- [ ] 1.3 Apply locally (`npm run prisma:migrate` against a dev DB / or `migrate deploy` on a seeded fixture) and confirm the test from 1.1 goes green.
- [ ] 1.4 Capture the audit NOTICE output — this is the Phase 4 gate. ✅ **VERIFY: orphan counts recorded.**
- [ ] 1.5 Deploy Phase 1 (backfill runs on container boot). No behavior change. ✅ **DEPLOY GATE.**

## Phase 2 — Stop WRITING the legacy columns — depends on Phase 1

- [ ] 2.1 (TEST) Update `scheduling.dto.test.ts`: assert `CreateTaskSchema`/`UpdateTaskSchema` no longer carry `assignedTo`, `assignedToId`, `clientId`, `clientName`, `scheduledDate`, `scheduledTime` (parsing a body with them does not surface them in the parsed output).
- [ ] 2.2 Remove the six deprecated input fields from `CreateTaskBaseSchema` in `src/application/dto/scheduling.dto.ts`. (Leave `status`/`TaskStatusSchema` for Phase 3.)
- [ ] 2.3 Remove the legacy keys from `normalized` object in `scheduling.routes.ts` create handler (lines ~254-261).
- [ ] 2.4 Remove the legacy keys from `_buildCreateData` and `_buildUpdateData` in `PrismaSchedulingRepository.ts` (lines ~436-443, ~469-476).
- [ ] 2.5 Remove the legacy keys from create/update in `InMemorySchedulingRepository.ts`.
- [ ] 2.6 (TEST) supertest: creating a task with legacy fields in the body succeeds and the response is unchanged; created row has null legacy columns. Run `npm test`. ✅ **VERIFY: green.**
- [ ] 2.7 `tsc --noEmit` green.
- [ ] 2.8 Deploy Phase 2. New rows stop populating legacy columns. Reads still fall back (safe). ✅ **DEPLOY GATE.**

## Phase 3 — Stop READING the legacy columns (lockstep with frontend) — depends on Phase 2

### Frontend (sibling repo — must merge before/with this phase)
- [ ] 3.1 (FE) `SchedulingDashboardPage.tsx`: `t.status === 'in_progress'/'completed'` → `t.stageCategory === 'enProgreso'/'hecho'`; sort by `startDate` not `scheduledDate`.
- [ ] 3.2 (FE) `SchedulingCalendarPage/index.tsx`: use `task.startDate` directly; drop `scheduledDate`/`scheduledTime`/`clientName` fallbacks (use `customerName`).
- [ ] 3.3 (FE) `KanbanCard.tsx`: drop `clientName` fallback → `customerName` only.
- [ ] 3.4 (FE) `types/scheduling.ts`: remove the 6 legacy fields + `status`/`TaskStatus`. `tsc` + Vitest green.

### Backend
- [ ] 3.5 (TEST) Mapper test: `toTask`/`makeTask` output no longer contains `status`, `clientName`, `assignedTo`, `assignedToId`, `clientId`, `scheduledDate`, `scheduledTime`; `customerName` derives only from the JOIN (null when no `customerId`).
- [ ] 3.6 (TEST) `scheduling-composition.test.ts`: `PATCH /api/scheduling/:id/status` returns 404 and does NOT shadow `GET /:id`.
- [ ] 3.7 Remove `status`, `TaskStatus`, and the 6 legacy fields from `ScheduledTask` in `src/domain/entities/scheduling.ts`.
- [ ] 3.8 Remove `TaskStatusSchema` and `UpdateStatusSchema` from `scheduling.dto.ts` (and their exported types).
- [ ] 3.9 Delete `src/application/use-cases/UpdateTaskStatus.ts`.
- [ ] 3.10 `PrismaSchedulingRepository.ts`: remove `deriveLegacyStatus`, the `clientName`/`assignedTo` fallback derivations, and the `status`/legacy fields from `toTask`.
- [ ] 3.11 `InMemorySchedulingRepository.ts`: remove `deriveLegacyStatus`, `status` and legacy fields from `makeTask`/create/update.
- [ ] 3.12 `scheduling.routes.ts`: remove `PATCH /:id/status` route and the `UpdateStatusSchema` import; remove `updateTaskStatus` route param.
- [ ] 3.13 `app.ts`: remove the `UpdateTaskStatus` instantiation and its injection into the scheduling router ⚠ (single surgical block).
- [ ] 3.14 Adapt remaining test files (`scheduling.routes.test.ts`, `scheduling.routes.filter.test.ts`, `scheduling.dto.test.ts`) — drop legacy-field assertions/fixtures.
- [ ] 3.15 `npm test` green; `tsc --noEmit` green. ✅ **VERIFY.**
- [ ] 3.16 Deploy backend Phase 3 + frontend together. API no longer exposes legacy fields; columns still exist physically but are unread. ✅ **DEPLOY GATE (lockstep).**

## Phase 4 — Contract (DROP columns) — depends on Phase 3 fully live

- [ ] 4.1 Re-check Phase 1 audit gate (4.x only proceeds if orphan counts are 0 or accepted residue). ✅ **GATE.**
- [ ] 4.2 Take a PROD DB snapshot. ✅ **SAFETY GATE.**
- [ ] 4.3 Edit `prisma/schema.prisma`: remove the 6 deprecated columns and the `@@index([status])` + `@@index([scheduledDate])` lines from `ScheduledTask`.
- [ ] 4.4 Create migration dir `prisma/migrations/<ts>_scheduledtask_drop_deprecated/` with the DROP DDL from `design.md`. Ensure `schema.prisma` and migration agree (`prisma migrate diff` clean).
- [ ] 4.5 (TEST) Run full scheduling route + adapter suite against a freshly migrated DB; `npm test` green.
- [ ] 4.6 Confirm `schema.prisma` `ScheduledTask` has zero `@deprecated` annotations.
- [ ] 4.7 Deploy Phase 4 (`migrate deploy` drops columns on boot). ✅ **FINAL DEPLOY GATE.**

## Verification Checklist (post Phase 4)

- [ ] V.1 `grep -i deprecated prisma/schema.prisma` shows no ScheduledTask hits.
- [ ] V.2 Tasks list shows correct `customerName`/`assigneeName` for previously-legacy rows (no blanks).
- [ ] V.3 Calendar, Dashboard, Kanban render with no console errors / Invalid Date.
- [ ] V.4 `npm test` + `tsc --noEmit` green in both repos.
