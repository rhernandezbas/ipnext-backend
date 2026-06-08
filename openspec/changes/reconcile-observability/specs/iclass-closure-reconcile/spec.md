# Delta for iclass-closure-reconcile

## ADDED Requirements

### Requirement: Per-Task Reconcile Failure Logging

`reconcileOne` MUST log a warning for every per-task failure before incrementing `counts.failed`. The log MUST identify the task by `sequenceNumber` and include the error message. The failure MUST NOT abort the batch (isolation preserved). A successful task MUST NOT produce a failure log entry.

Log format: `[backfill] task <sequenceNumber> FAILED: <message>`

#### Scenario: Per-task error is logged and counted, batch continues

- GIVEN `reconcileOne` is invoked within a batch
- AND the underlying iclass/ingest call throws an error for one task
- WHEN `BackfillClosedServiceOrders.execute()` processes that task
- THEN a warning is logged matching `[backfill] task <sequenceNumber> FAILED: <message>`
- AND `counts.failed` is incremented by 1
- AND the batch continues processing remaining tasks without throwing

#### Scenario: Per-task error is logged for 1x1 reconcile

- GIVEN `reconcileOne` is invoked from `ReconcileTaskClosure` (single-task path)
- AND the underlying call throws an error
- WHEN the use case executes
- THEN a warning is logged matching `[backfill] task <sequenceNumber> FAILED: <message>`
- AND `counts.failed` is incremented

#### Scenario: Successful task does not emit a failure log

- GIVEN `reconcileOne` is invoked and the underlying call succeeds
- WHEN `BackfillClosedServiceOrders.execute()` processes that task
- THEN no `[backfill] task ... FAILED` warning is logged for that task

---

### Requirement: In-Flight Task Count Display

The Reconcile page MUST display the count of in-flight tasks equal to `items.length` from `useInFlightTasks`. The count MUST reflect the rendered list at all times. When the list is empty, the count MUST show 0 (or be hidden with the empty state).

#### Scenario: Non-empty list shows correct count

- GIVEN `useInFlightTasks` returns N items (N > 0)
- WHEN `ReconcileInFlightPage` / `InFlightTasksTable` renders
- THEN a count element displays the value N
- AND the count equals `items.length`

#### Scenario: Empty list shows zero or hides count

- GIVEN `useInFlightTasks` returns an empty array
- WHEN the page renders
- THEN the count shows 0 OR the empty state is shown (no count claiming non-zero tasks)

#### Scenario: Count tracks list after reconcile action

- GIVEN the page is showing N in-flight tasks
- WHEN one task is successfully reconciled and the list refetches with N-1 items
- THEN the count updates to N-1
