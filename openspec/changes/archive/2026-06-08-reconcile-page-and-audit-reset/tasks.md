# Tasks: Reconcile Page + Per-Task/Batch Reconcile (#35, Part 2)

> Part 1 shipped. No migration in these tasks. Strict TDD: RED → GREEN → REFACTOR.
> Spec scenarios mapped inline. BE runner: `npx jest <pattern>` / `npx tsc --noEmit`. FE: `npx vitest run <pattern>` / `npm run typecheck`.

---

## Batch A — Backend

### Phase A1: DTO + reconcileOne refactor (foundation)

- [x] A1.1 **[RED]** In `BackfillClosedServiceOrders.test.ts`, add scenario: batch result is identical after extracting `reconcileOne` (scenario: "Batch processes all in-flight tasks identically after refactor"). Confirm test fails before refactor.
- [x] A1.2 **[GREEN]** Extract `reconcileOne(task, begin, now, counts)` as a `public` method on `BackfillClosedServiceOrders`; replace the inline per-task body in `execute()` with `await this.reconcileOne(task, begin, now, counts); await this.sleep(this.throttleMs)`. All existing `BackfillClosedServiceOrders` tests must stay green.
- [x] A1.3 **[GREEN]** Extend `application/dto/iclassClosure.dto.ts` with `InFlightTaskDto` interface and `toInFlightTaskDto` mapper (fields: `id`, `sequenceNumber`, `title`, `customerName`, `customerCode`, `iclassOrderCode`).
- [x] A1.4 Run `npx tsc --noEmit` (BE) — zero errors.

### Phase A2: ListInFlightTasks use case

- [x] A2.1 **[RED]** Create `src/__tests__/application/ListInFlightTasks.test.ts`: seed in-memory scheduling repo with one `registered_in_iclass` task; assert result is `InFlightTaskDto[]` with correct fields; assert raw `ScheduledTask` is NOT returned.
- [x] A2.2 **[GREEN]** Create `src/application/use-cases/ListInFlightTasks.ts`: `execute()` calls `scheduling.listTasksInIClassStage('registered_in_iclass')` → maps each task with `toInFlightTaskDto` → returns array. (Scenario: "Authenticated operator fetches in-flight tasks", "Empty list when no tasks are in-flight".)
- [x] A2.3 Run `npx jest ListInFlightTasks` — green.

### Phase A3: ReconcileTaskClosure use case

- [x] A3.1 **[RED]** Create `src/__tests__/application/ReconcileTaskClosure.test.ts` covering:
  - Task found + SO closed within 29 days → `mirrored/transitioned > 0` (scenario: "Successfully reconciles an in-flight task").
  - Task found + SO not closed / outside 29-day window → `skippedNotClosed` incremented (scenario: "SO older than 29-day lookback").
  - Idempotent re-run → 200 no error (scenario: "Idempotent re-run").
  - Task not found → throws `TaskNotFoundError` (scenario: "Task not found returns 404").
- [x] A3.2 **[GREEN]** Create `src/application/use-cases/ReconcileTaskClosure.ts`: constructor receives `SchedulingRepository` + `BackfillClosedServiceOrders`; `execute(taskId)`: `scheduling.getTask(taskId)` → null → `throw new TaskNotFoundError(taskId)` → call `backfill.reconcileOne(task, begin, now, counts)` once (derive `begin` from `backfill.lookbackDays`) → return counts.
- [x] A3.3 Run `npx jest ReconcileTaskClosure` — green.

### Phase A4: Routes + app.ts wiring

- [x] A4.1 **[RED]** Extend `src/__tests__/infrastructure/iclass-closure.routes.test.ts` with:
  - `GET /closure/in-flight` 200 list (scenario: "Authenticated operator fetches in-flight tasks").
  - `GET /closure/in-flight` 200 empty array (scenario: "Empty list when no tasks are in-flight").
  - `GET /closure/in-flight` 401 unauthenticated (scenario: "Unauthenticated request is rejected").
  - `GET /closure/in-flight` 403 no `iclass.manage` (scenario: "Request without iclass.manage is forbidden").
  - `POST /closure/reconcile/:taskId` 200 + counts (scenario: "Successfully reconciles").
  - `POST /closure/reconcile/:taskId` 404 unknown id (scenario: "Task not found returns 404").
  - `POST /closure/reconcile/:taskId` 401/403 (scenario: "Unauthenticated / forbidden requests rejected").
  - Existing backfill routes unchanged (scenario: "Batch processes all in-flight tasks identically after refactor").
- [x] A4.2 **[GREEN]** Modify `src/infrastructure/http/routes/iclass-closure.routes.ts`: add `listInFlight: ListInFlightTasks` and `reconcile: ReconcileTaskClosure` to router factory params; add `GET /in-flight` and `POST /reconcile/:taskId` handlers, both guarded by `requireIClassManage`.
- [x] A4.3 **[GREEN]** Modify `src/infrastructure/http/app.ts`: construct `ListInFlightTasks` and `ReconcileTaskClosure` instances; pass them to `createIClassClosureRouter`.
- [x] A4.4 Run `npx jest iclass-closure.routes` — green. Run `npx tsc --noEmit` — zero errors.

### Phase A5: Batch A full verify

- [x] A5.1 Run `npx jest --runInBand` — all suites green (15 spec scenarios covered).
- [x] A5.2 Run `npx tsc --noEmit` — zero errors.

---

## Batch B — Frontend

### Phase B1: API layer + hooks

- [x] B1.1 **[RED]** Add tests to `src/__tests__/hooks/useIClassClosure.test.ts`: `useInFlightTasks` returns `InFlightTask[]`; `useReconcileTask` calls `reconcileTask(id)` and invalidates `['iclassClosure','inFlight']` on success.
- [x] B1.2 **[GREEN]** Extend `src/api/iclassClosure.api.ts`: add `InFlightTask` and `InFlightTaskList` types; add `inFlightList()` (`GET /closure/in-flight`) and `reconcileTask(id)` (`POST /closure/reconcile/:taskId`).
- [x] B1.3 **[GREEN]** Extend `src/hooks/useIClassClosure.ts`: add `useInFlightTasks()` (TanStack Query, optional `refetchInterval` mirroring `usePendingList`) and `useReconcileTask()` (mutation → on success: invalidate `['iclassClosure','inFlight']`).
- [x] B1.4 Run `npx vitest run useIClassClosure` — green. Run `npm run typecheck` — zero errors.

### Phase B2: InFlightTasksTable component

- [x] B2.1 **[RED]** Create `src/__tests__/scheduling/settings/InFlightTasksTable.test.tsx`: row renders `sequenceNumber`, `title`, `customerName`, `iclassOrderCode` (scenario: "Page lists in-flight tasks"); "Reconciliar" per row triggers `useReconcileTask` and refetches list (scenario: "Per-row reconcile removes closed task from list"); "no se encontró cierre reciente" shown when `mirrored===0 && transitioned===0`; empty state rendered when list is empty (scenario: "Empty state shown when no tasks are in-flight"); "Reconciliar todas" calls backfill (scenario: "'Reconciliar todas' triggers batch backfill").
- [x] B2.2 **[GREEN]** Create `src/pages/scheduling/settings/InFlightTasksTable.tsx`: table with columns `sequenceNumber`, `title`, `customerName`, `iclassOrderCode`; per-row "Reconciliar" button using `useReconcileTask`; inline result with "no se encontró cierre reciente" guard; header "Reconciliar todas" reusing `useRunClosureBackfill`; empty state.
- [x] B2.3 Run `npx vitest run InFlightTasksTable` — green.

### Phase B3: ReconcileInFlightPage + routing

- [x] B3.1 **[RED]** Create `src/__tests__/scheduling/ReconcileInFlightPage.test.tsx`: page renders `InFlightTasksTable`; gated by `iclass.manage` (`RequirePermission`) (scenario: "Page is not accessible without iclass.manage"); link from `IClassClosureFlagBody` is present (scenario: "Reconcile page is reachable from IClassClosureFlagBody").
- [x] B3.2 **[GREEN]** Create `src/pages/scheduling/ReconcileInFlightPage.tsx`: lazy-loaded, wrapped in `RequirePermission` with `iclass.manage`; renders `InFlightTasksTable` with page header. Mirror `ClosurePendingPage` structure.
- [x] B3.3 **[GREEN]** Modify `src/App.tsx`: add lazy import for `ReconcileInFlightPage`; add `<Route path="iclass/closure/reconcile" element={<ReconcileInFlightPage />}>` gated by `iclass.manage`.
- [x] B3.4 **[GREEN]** Modify `src/pages/scheduling/settings/IClassClosureFlagBody.tsx`: add a link/button to `/admin/scheduling/iclass/closure/reconcile` near the backfill card (analogous to the pending-list link).
- [x] B3.5 Run `npx vitest run ReconcileInFlightPage` — green. Run `npm run typecheck` — zero errors.

### Phase B4: impeccable polish

- [x] B4.1 **[impeccable]** Review `ReconcileInFlightPage` and `InFlightTasksTable` for visual hierarchy, spacing, empty state, inline result display, and button placement. Apply fixes until the page matches the `ClosurePendingPage` quality bar.

### Phase B5: Batch B full verify

- [x] B5.1 Run `npx vitest run --reporter=verbose` — all FE suites green.
- [x] B5.2 Run `npm run typecheck` — zero errors.

---

## Scenario Coverage Map

| Spec Scenario | Task(s) |
|---|---|
| Authenticated operator fetches in-flight tasks | A2.1, A4.1 |
| Empty list when no tasks are in-flight | A2.1, A4.1 |
| Unauthenticated GET rejected (401) | A4.1 |
| Forbidden GET without iclass.manage (403) | A4.1 |
| Successfully reconciles an in-flight task | A3.1, A4.1 |
| Task not found → 404 | A3.1, A4.1 |
| SO older than 29-day lookback | A3.1 |
| Idempotent re-run | A3.1 |
| Unauthenticated/forbidden POST rejected | A4.1 |
| Batch processes all tasks identically after refactor | A1.1, A5.1 |
| Page lists in-flight tasks | B2.1 |
| Per-row reconcile removes closed task from list | B2.1 |
| "Reconciliar todas" triggers batch backfill | B2.1 |
| Empty state shown when no tasks are in-flight | B2.1 |
| Page not accessible without iclass.manage | B3.1 |
| Reconcile page reachable from IClassClosureFlagBody | B3.1 |
