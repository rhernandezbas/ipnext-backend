<!-- generated from engram topic_key: sdd/task-activity-log/tasks -->
## Tasks — task-activity-log
Strict TDD: every task starts with a failing test. Test runner: `npm test`.

### Phase A — Foundations (domain + persistence)
- [x] A.1 — Add `ActivityType` union + `TaskActivity` entity in `src/domain/entities/taskActivity.ts`.
- [x] A.2 — Add `TaskActivityRepository` port (`create`, `createMany`, `listByTask`) in `src/domain/ports/TaskActivityRepository.ts`.
- [x] A.3 — Add `TaskActivityRecorder` port + `ActorContext` interface in `src/domain/ports/TaskActivityRecorder.ts`.
- [x] A.4 — Add `InvalidCursorError` in `src/domain/errors/scheduling.ts` (or new errors file).
- [x] A.5 — Prisma model `ScheduledTaskActivity` + back-relations on `ScheduledTask` and `RbacUser`. Create migration `20260530000000_add_scheduled_task_activity`. Run `npm run prisma:migrate` (user-triggered).
- [x] A.6 — Implement `InMemoryTaskActivityRepository` with cursor semantics. TEST FIRST (`src/__tests__/infrastructure/InMemoryTaskActivityRepository.test.ts`): ordering, cursor exclusivity, limit, createMany.
- [x] A.7 — Implement `PrismaTaskActivityRepository`. Integration test mirroring the in-memory contract.

### Phase B — Read side
- [x] B.1 — TEST `GetTaskActivity`: 404 when task missing, clamp limit, default limit, cursor decode/encode, returns `{items, nextCursor}`.
- [x] B.2 — Implement `GetTaskActivity` in `src/application/use-cases/GetTaskActivity.ts`.
- [x] B.3 — Add cursor codec utility (`encodeCursor`/`decodeCursor`) — colocated or in `application/util/`.
- [x] B.4 — TEST `GET /api/scheduling/tasks/:id/activity` via supertest: empty, paginated, malformed cursor (400), unauth (401), unknown task (404).
- [x] B.5 — Wire the new route in `scheduling.routes.ts` between auth middleware and the existing `:id` handlers (route order matters — define before `:id` GET).
- [x] B.6 — DI wiring in `app.ts`: build repository + recorder + `GetTaskActivity` and pass into the scheduling router factory.

### Phase C — Write side (recorder + RecordTaskActivity)
- [x] C.1 — TEST `RecordTaskActivity` use case (persists via repo with correct shape).
- [x] C.2 — Implement `RecordTaskActivity` in `src/application/use-cases/RecordTaskActivity.ts`.
- [x] C.3 — TEST `DefaultTaskActivityRecorder`: success path, swallow-and-warn on failure, `recordMany` batching.
- [x] C.4 — Implement `DefaultTaskActivityRecorder` in `src/infrastructure/services/DefaultTaskActivityRecorder.ts`.

### Phase D — Instrument write use cases
For each: TEST (recorder called with right payload) → modify UC constructor (add `recorder`) + `execute(...)` (add `actor` param) → update DI in `app.ts` → update route to pass `actor`.

- [x] D.1 — `CreateTask` → `created` event.
- [x] D.2 — `UpdateTask` → diff engine emitting 0..N events. SUB-tasks per field family:
  - [x] D.2.a `priority_changed`
  - [x] D.2.b `category_changed`
  - [x] D.2.c `assigned` / `unassigned`
  - [x] D.2.d `reporter_changed`
  - [x] D.2.e `watcher_added` / `watcher_removed` (set diff)
  - [x] D.2.f `description_changed`
  - [x] D.2.g `due_date_changed` (startDate, endDate — metadata.field)
  - [x] D.2.h `project_changed`
  - [x] D.2.i `address_changed` (coalesce address+coords)
  - [x] D.2.j `estimated_hours_changed`
  - [x] D.2.k `travel_time_changed` (coalesce both)
  - [x] D.2.l `notes_changed`
  - [x] D.2.m `status_changed` (isClosed)
  - [x] D.2.n `inventory_review_changed` (when via UpdateTask)
- [x] D.3 — `MoveTaskToStage` → `stage_changed` (skip when delegating to SendTaskToIClass — that UC emits its own).
- [x] D.4 — `BulkMoveTasksToStage` → batched per task.
- [x] D.5 — `AddTaskComment` → `commented` + per-attachment `attachment_added`.
- [x] D.6 — `DeleteTaskComment` → `comment_deleted`.
- [x] D.7 — `SetTaskInventoryReview` → `inventory_review_changed`.
- [x] D.8 — `AddChecklistItem` → `checklist_item_added`.
- [x] D.9 — `UpdateChecklistItem` → `checklist_item_updated`.
- [x] D.10 — `ToggleChecklistItem` → `checklist_item_toggled`.
- [x] D.11 — `RemoveChecklistItem` → `checklist_item_removed`.
- [x] D.12 — `ReorderChecklistItems` → `checklist_reordered`.
- [x] D.13 — `AssignTemplateToTask` → `checklist_template_assigned`.
- [x] D.14 — `ClearTaskChecklist` → `checklist_cleared`.
- [x] D.15 — `SendTaskToIClass` → `sent_to_iclass`.

### Phase E — Cross-cutting
- [x] E.1 — Route updates: every scheduling/comments/checklist write route reads `req.user` and forwards `actor` to the UC.
- [x] E.2 — Integration test: full happy-path flow (create → update priority → move stage → add comment) and assert the activity feed returns 4 events in the right order.
- [x] E.3 — Resilience test: stub recorder to throw on every call, assert all originating endpoints still succeed.
- [x] E.4 — `tsc --noEmit` clean.
- [x] E.5 — `npm test` green.

### Phase F — Out of scope (do NOT include in this change)
- Frontend consumption (separate `task-activity-log-frontend` change).
- Backfill of historical tasks.
- Attachment standalone endpoint events.
- Notifications / push / email on activity.

### Estimated complexity of /sdd-apply
- **Files touched**: ~35–40
  - 2 new domain (entity + 2 ports)
  - 1 errors file edit
  - 1 prisma schema + 1 migration
  - 2 adapters (Prisma + InMemory)
  - 2 new use cases (Get, Record) + 1 recorder service
  - 1 cursor codec util
  - 18 existing write use cases modified (constructor + execute signature)
  - 4–6 routes modified to forward actor
  - 1 app.ts DI rewire
  - ~25 new test files (one per UC + adapters + integration suite)
- **Risk hotspots**:
  - `UpdateTask` diff engine — most complex single change (14 field families). Likely warrants its own helper `computeUpdateTaskActivities(prev, next)`.
  - `app.ts` is a known god-object (~617 lines) — adding 18 recorder injections will bloat further; consider a small "scheduling DI factory" extraction if budget allows, otherwise inline and revisit later.
  - Route signature change (passing `actor`) ripples across ~20 supertest assertions — most will pass unchanged thanks to default user, but expect noise.
- **Estimated effort**: 2–3 focused sessions in Strict TDD mode. Phase A+B can be one session (read side end-to-end). Phase C+D split by family. Phase E final integration.
- **Migration safety**: additive only (new table, FK with cascade). No existing data touched. Safe to ship before any UC changes.
