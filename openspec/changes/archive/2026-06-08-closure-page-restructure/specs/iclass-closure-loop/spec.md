# Delta for iclass-closure-loop

## ADDED Requirements

### Requirement: listPendingSideEffectsWithTask port method

`ClosedServiceOrderRepository` MUST expose `listPendingSideEffectsWithTask(maxAuditAttempts: number)` returning an array of items typed as `PendingClosureSideEffectsWithTask`. Each item MUST include all fields from `PendingClosureSideEffects` (`iclassId`, `scheduledTaskId`, `commentPosted`, `inventoryBuilt`, `auditDone`, `auditAttempts`) plus an optional `task` field (`{ id: string; sequenceNumber: number; title: string } | null`). The method MUST resolve the task in a single query (no N+1) using a JOIN or include. The in-memory adapter MUST implement the same method.

#### Scenario: Port returns items with joined task

- GIVEN the in-memory adapter has 2 pending SOs, one with `scheduledTaskId` pointing to a seeded task
- WHEN `listPendingSideEffectsWithTask(maxAuditAttempts)` is called
- THEN it returns 2 items: one with `task.sequenceNumber` populated, one with `task: null`

#### Scenario: Port returns empty array when nothing pending

- GIVEN the in-memory adapter has no pending SOs
- WHEN `listPendingSideEffectsWithTask(maxAuditAttempts)` is called
- THEN it returns `[]`

#### Scenario: Port method is additive — existing listPendingSideEffects unchanged

- GIVEN both `listPendingSideEffects` and `listPendingSideEffectsWithTask` are defined on the port
- WHEN `listPendingSideEffects` is called (by existing use cases)
- THEN its behavior and return shape are unchanged
