# iclass-closure-reconcile Specification

## Purpose

Operators can list tasks currently stuck in the `registered_in_iclass` stage and reconcile
them individually (synchronous, 200) or in batch (existing async 202). This capability adds
the `GET /closure/in-flight` and `POST /closure/reconcile/:taskId` endpoints and the
corresponding FE page.

---

## Requirements

### Requirement: In-Flight Task List Endpoint

The system MUST expose `GET /api/admin/iclass/closure/in-flight`, gated by `iclass.manage`,
returning a DTO list of every task currently in stage `registered_in_iclass`.

Each item in the list MUST contain: `id`, `sequenceNumber`, `title`, `customerName`,
`iclassOrderCode`. Raw `ScheduledTask` or Prisma rows MUST NOT be returned.

#### Scenario: Authenticated operator fetches in-flight tasks

- GIVEN an operator with `iclass.manage` permission
- AND at least one task is in stage `registered_in_iclass`
- WHEN `GET /api/admin/iclass/closure/in-flight` is called
- THEN response is 200 with a list where each item has `id`, `sequenceNumber`, `title`, `customerName`, `iclassOrderCode`

#### Scenario: Empty list when no tasks are in-flight

- GIVEN an operator with `iclass.manage` permission
- AND no tasks are in stage `registered_in_iclass`
- WHEN `GET /api/admin/iclass/closure/in-flight` is called
- THEN response is 200 with an empty array

#### Scenario: Unauthenticated request is rejected

- GIVEN no authentication token
- WHEN `GET /api/admin/iclass/closure/in-flight` is called
- THEN response is 401

#### Scenario: Request without iclass.manage is forbidden

- GIVEN an authenticated operator WITHOUT `iclass.manage`
- WHEN `GET /api/admin/iclass/closure/in-flight` is called
- THEN response is 403

---

### Requirement: Per-Task Synchronous Reconcile Endpoint

The system MUST expose `POST /api/admin/iclass/closure/reconcile/:taskId`, gated by
`iclass.manage`, that reconciles ONE task synchronously and returns 200 with counts
`{ mirrored, transitioned, skippedNotClosed, skippedNotOurs, skippedUnchanged, failed }`.

The operation MUST be idempotent — re-running on the same task is safe (replace-on-rerun).

#### Scenario: Successfully reconciles an in-flight task

- GIVEN an operator with `iclass.manage` and a task in stage `registered_in_iclass`
- AND the task's SO has a closure within the 29-day lookback window
- WHEN `POST /closure/reconcile/:taskId` is called
- THEN response is 200 with counts `{ mirrored, transitioned, skippedNotClosed, skippedNotOurs, skippedUnchanged, failed }`
- AND the task transitions out of `registered_in_iclass` (visible on list refetch)

#### Scenario: Task not found returns 404

- GIVEN an operator with `iclass.manage`
- AND no task exists with the given `taskId`
- WHEN `POST /closure/reconcile/:taskId` is called
- THEN response is 404

#### Scenario: SO older than 29-day lookback — no recent closure signal

- GIVEN an operator with `iclass.manage` and a task in stage `registered_in_iclass`
- AND the task's SO has no closure event within the last 29 days
- WHEN `POST /closure/reconcile/:taskId` is called
- THEN response is 200 with `skippedNotClosed` incremented (or equivalent "no recent closure" signal)
- AND the task remains in `registered_in_iclass`

#### Scenario: Idempotent re-run

- GIVEN a task already reconciled in the same session
- WHEN `POST /closure/reconcile/:taskId` is called again
- THEN response is 200 (no error)
- AND counts reflect the current state (no duplicate side-effects)

#### Scenario: Unauthenticated / forbidden requests rejected

- GIVEN no auth token OR a token without `iclass.manage`
- WHEN `POST /closure/reconcile/:taskId` is called
- THEN response is 401 or 403 respectively

---

### Requirement: Batch Behavior Preserved After reconcileOne Extraction

The system MUST ensure that extracting the per-task logic into a shared `reconcileOne`
helper does NOT change how `BackfillClosedServiceOrders` processes tasks.

#### Scenario: Batch processes all in-flight tasks identically after refactor

- GIVEN multiple tasks in stage `registered_in_iclass`
- AND the per-task logic has been extracted to `reconcileOne`
- WHEN `BackfillClosedServiceOrders.execute()` is called
- THEN all tasks are processed with the same outcome as before the refactor
- AND aggregate counts match the sum of per-task counts

---

### Requirement: Reconcile In-Flight Page (FE)

The FE MUST provide a page at `/admin/scheduling/iclass/closure/reconcile` gated by
`iclass.manage`, listing in-flight tasks with per-row and batch reconcile actions.

#### Scenario: Page lists in-flight tasks

- GIVEN an operator with `iclass.manage`
- AND the API returns a non-empty in-flight list
- WHEN the reconcile page is visited
- THEN each task row shows `sequenceNumber`, `title`, `customerName`, `iclassOrderCode`
- AND each row has a "Reconciliar" button

#### Scenario: Per-row reconcile removes closed task from list

- GIVEN the reconcile page showing at least one in-flight task
- WHEN the operator clicks "Reconciliar" on a row
- AND the API returns 200 (task successfully reconciled and transitions out of in-flight)
- THEN the in-flight list refetches
- AND the reconciled task no longer appears

#### Scenario: "Reconciliar todas" triggers batch backfill

- GIVEN the reconcile page
- WHEN the operator clicks "Reconciliar todas"
- THEN the existing `POST /closure/backfill` endpoint is called (202)
- AND the batch is queued

#### Scenario: Empty state shown when no tasks are in-flight

- GIVEN no tasks in stage `registered_in_iclass`
- WHEN the reconcile page is visited
- THEN an empty state is shown

#### Scenario: Page is not accessible without iclass.manage

- GIVEN an authenticated user WITHOUT `iclass.manage`
- WHEN the user navigates to `/admin/scheduling/iclass/closure/reconcile`
- THEN access is denied (redirect or permission error)

#### Scenario: Reconcile page is reachable from IClassClosureFlagBody

- GIVEN `IClassClosureFlagBody` is rendered
- THEN a link to the reconcile page is present (analogous to the pending-list link)
