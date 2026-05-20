# Tasks: Scheduling Tasks Enrich

**Mode**: Strict TDD — every code task starts with a failing test (red), then implementation (green), then refactor.
**Verification gate**: `tsc --noEmit` + `npm test` must pass before declaring a phase done.
**Reminder**: do NOT run `npm run build`. The user owns that decision.

---

## 1. Infrastructure: Schema & Migration

- [x] 1.1 Edit `prisma/schema.prisma`:
  - [x] 1.1.1 Add `startDate DateTime?`, `endDate DateTime?` to `ScheduledTask`.
  - [x] 1.1.2 Add `customerId String?` with `customer Client? @relation(fields: [customerId], references: [id], onDelete: SetNull)`.
  - [x] 1.1.3 Add `serviceId String?` with `service Service? @relation(fields: [serviceId], references: [id], onDelete: SetNull)`.
  - [x] 1.1.4 Add `partnerId String?` with `partnerRef Partner? @relation(fields: [partnerId], references: [id], onDelete: SetNull)` (rename hint: avoid clash with `Project.partners`).
  - [x] 1.1.5 Add `reporterId String?` with `reporter Admin? @relation("TaskReporter", fields: [reporterId], references: [id], onDelete: SetNull)`.
  - [x] 1.1.6 Add `assigneeId String?` with `assignee Admin? @relation("TaskAssignee", fields: [assigneeId], references: [id], onDelete: SetNull)`.
  - [x] 1.1.7 Add `travelTimeTo Int?`, `travelTimeFrom Int?`.
  - [x] 1.1.8 Add `watchers TaskWatcher[]` back-relation on `ScheduledTask`.
  - [x] 1.1.9 Add new model `TaskWatcher { taskId String, adminId String, task ScheduledTask @relation(fields: [taskId], references: [id], onDelete: Cascade), admin Admin @relation("TaskWatcher", fields: [adminId], references: [id], onDelete: Cascade), @@id([taskId, adminId]), @@index([adminId]) }`.
  - [x] 1.1.10 Add back-relations on `Client` (`tasks ScheduledTask[]`), `Service` (`tasks ScheduledTask[]`), `Partner` (`tasks ScheduledTask[]`), `Admin` (`tasksReported ScheduledTask[] @relation("TaskReporter")`, `tasksAssigned ScheduledTask[] @relation("TaskAssignee")`, `tasksWatching TaskWatcher[] @relation("TaskWatcher")`).
  - [x] 1.1.11 Add indexes: `@@index([startDate])`, `@@index([endDate])`, `@@index([customerId])`, `@@index([serviceId])`, `@@index([partnerId])`, `@@index([assigneeId])`, `@@index([reporterId])` on `ScheduledTask`.
  - [x] 1.1.12 Annotate legacy columns with `///` doc-comments noting deprecation: `scheduledDate`, `scheduledTime`, `clientId`, `clientName`, `assignedTo`, `assignedToId`, `status`.
- [x] 1.2 Migration SQL written manually at `prisma/migrations/20260520020000_scheduling_tasks_enrich/migration.sql` (no DB available; --create-only pattern used).
- [x] 1.3 Hand-edit the generated `migration.sql`:
  - [x] 1.3.1 Verify NO `ON CONFLICT ON CONSTRAINT <index_name>` appears anywhere.
  - [x] 1.3.2 Append the `DO $$ ... $$` per-row datetime backfill block (full SQL in `design.md` §Migration / Rollout).
  - [x] 1.3.3 Add the down-SQL header comment (same style as change 2).
- [ ] 1.4 Verify migration applies cleanly on a fresh DB AND on a DB pre-populated with change-1/2 data.
  - [ ] Manual smoke (ops): drop DB → migrate → seed → migrate again (idempotency check). [BLOCKED: no DB available in apply phase]
- [ ] 1.5 Run `npx prisma generate` to refresh the Prisma client. [BLOCKED: no DB available; `as any` casts used in adapter]

---

## 2. Domain Layer

- [x] 2.1 RED: write failing test `src/__tests__/domain/errors/scheduling.test.ts` asserting `ReferenceNotFoundError` constructor sets `kind`, `id`, `message`, and `name`.
- [x] 2.2 GREEN: add `ReferenceNotFoundError` to `src/domain/errors/scheduling.ts`. Export `ReferenceKind` type.
- [x] 2.3 Extend `src/domain/entities/scheduling.ts`:
  - [x] 2.3.1 Add `startDate`, `endDate`, `customerId`, `customerName`, `serviceId`, `partnerId`, `reporterId`, `assigneeId`, `assigneeName`, `watcherIds`, `travelTimeTo`, `travelTimeFrom`.
  - [x] 2.3.2 Mark legacy fields with `@deprecated` JSDoc.
- [x] 2.4 Widen `src/domain/ports/SchedulingRepository.ts`:
  - [x] 2.4.1 Define `CreateTaskInput` extending `Omit<ScheduledTask, 'id' | 'sequenceNumber' | 'stageCategory' | 'status' | 'customerName' | 'assigneeName' | 'watcherIds'>` plus `watcherIds?: string[]`.
  - [x] 2.4.2 Define `UpdateTaskInput extends Partial<CreateTaskInput>`.
  - [x] 2.4.3 Update `createTask` / `updateTask` signatures to use the new types.

---

## 3. Application Layer (DTOs & Use Cases)

### 3.1 DTOs

- [x] 3.1.1 RED: write failing tests in `src/__tests__/application/dto/scheduling.dto.test.ts`.
- [x] 3.1.2 GREEN: modify `src/application/dto/scheduling.dto.ts`:
  - [x] Add the new fields per the schema in `design.md` §Interfaces.
  - [x] Add the `superRefine` for `endDate >= startDate`.
  - [x] Keep deprecated fields optional.
  - [x] Re-export `CreateTaskInput`/`UpdateTaskInput` via `z.infer`.

### 3.2 Use cases

- [x] 3.2.1 RED: extend `src/__tests__/application/use-cases/CreateTask.test.ts`.
- [x] 3.2.2 GREEN: modify `src/application/use-cases/CreateTask.ts`.
- [x] 3.2.3 RED: extend `src/__tests__/application/use-cases/UpdateTask.test.ts`.
- [x] 3.2.4 GREEN: modify `src/application/use-cases/UpdateTask.ts`.

---

## 4. Adapters

### 4.1 Prisma adapter

- [x] 4.1.1 RED: write failing test `src/__tests__/infrastructure/adapters/prisma/PrismaSchedulingRepository.test.ts`.
- [x] 4.1.2 GREEN: rewrite `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts`.
- [x] 4.1.3 Verify the adapter still satisfies the `SchedulingRepository` port (TypeScript compile). ✓ tsc --noEmit clean.

### 4.2 In-memory adapter

- [x] 4.2.1 Modify `src/infrastructure/adapters/in-memory/InMemorySchedulingRepository.ts`.

---

## 5. HTTP Routes

- [x] 5.1 RED: extend `src/__tests__/infrastructure/http/routes/scheduling.routes.test.ts` (added at bottom of existing file).
- [x] 5.2 GREEN: modify `src/infrastructure/http/routes/scheduling.routes.ts`.

---

## 6. Wiring

- [x] 6.1 Modify `src/infrastructure/http/app.ts`.
- [x] 6.2 Updated `src/__tests__/infrastructure/scheduling-composition.test.ts` to pass `emptyLookup` to use-cases.

---

## 7. Final Verification

- [x] 7.1 Run `tsc --noEmit` — clean. ✓
- [x] 7.2 Run `npm test` — 654 tests green. ✓
- [x] 7.3 Legacy columns still returned (seeded tasks in InMemory still have them).
- [x] 7.4 Prisma adapter file is `PrismaSchedulingRepository.ts` exporting `class PrismaSchedulingRepository`. ✓
- [x] 7.5 Migration file contains NO `ON CONFLICT ON CONSTRAINT` and uses `DO $$ ... $$`. ✓
- [x] 7.6 Save `apply-progress` to engram. [pending — done after this update]

---

## Smoke (post-deploy — 10-step E2E)

[Requires a live DB with the migration applied. Run after deploy.]
