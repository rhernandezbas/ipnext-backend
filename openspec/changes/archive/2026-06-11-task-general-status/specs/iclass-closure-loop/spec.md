# Delta for iclass-closure-loop

**Capability**: `iclass-closure-loop` (MODIFIED)
**Change**: `task-general-status` (#41)

---

## ADDED Requirements

### Requirement: REQ-GS-ICLASS-DISMISSED-1 — dismissed tasks excluded from listTasksInIClassStage

`listTasksInIClassStage` (both `PrismaSchedulingRepository` and `InMemorySchedulingRepository`) MUST filter `generalStatus != 'dismissed'`. This covers both `ListInFlightTasks` and `BackfillClosedServiceOrders` — dismissed tasks are NOT reconciled or autocompleted. The `closed` status is intentionally NOT excluded (a closed task in flight should still be reconciled).

**Semantic**: dismissing a task means the operator has discarded it. Continuing to move its stage or post comments would be confusing and contradictory. The IClass SO mirror row is still ingested (REQ-GS-ICLASS-INGEST-1).

#### Scenario: Dismissed task absent from listTasksInIClassStage

- GIVEN task `t-1` has `stageCode = 'registered_in_iclass'` AND `generalStatus = 'dismissed'`
- WHEN `listTasksInIClassStage` is called
- THEN `t-1` MUST NOT appear in the result
- AND other non-dismissed tasks in the same stage MUST still appear

#### Scenario: Closed (not dismissed) task still appears

- GIVEN task `t-1` has `stageCode = 'registered_in_iclass'` AND `generalStatus = 'closed'`
- WHEN `listTasksInIClassStage` is called
- THEN `t-1` MUST appear (reconciliation proceeds normally)

#### Scenario: Open task still appears (unchanged)

- GIVEN task `t-1` has `stageCode = 'registered_in_iclass'` AND `generalStatus = 'open'`
- WHEN `listTasksInIClassStage` is called
- THEN `t-1` MUST appear

---

### Requirement: REQ-GS-ICLASS-INGEST-1 — IngestClosedServiceOrders skips task side-effects for dismissed tasks

When `IngestClosedServiceOrders` matches an IClass SO to a `ScheduledTask` via `findTaskBySequenceNumber` and the task has `generalStatus = 'dismissed'`, the use case MUST:
1. Persist/update the `IClassServiceOrder` mirror row (SO is still mirrored).
2. SKIP all task side-effects: no stage transition, no activity comment, no inventory side-effects.
3. Count the skipped task as `skippedDismissed` in the run summary.

**Rationale**: the operator dismissed the task intentionally. Mirroring the SO preserves audit trail without contaminating the dismissed task.

#### Scenario: Dismissed task — mirror only, no side-effects

- GIVEN an IClass SO with `codigo` matching task `t-1` (sequence number)
- AND `t-1.generalStatus = 'dismissed'`
- WHEN `IngestClosedServiceOrders` processes that SO
- THEN the `IClassServiceOrder` mirror row MUST be persisted/updated
- AND `t-1`'s stage MUST NOT change
- AND no `stage_changed` or `commented` activity MUST be recorded on `t-1`
- AND the SO is counted as `skippedDismissed`

#### Scenario: Non-dismissed task proceeds normally (unchanged)

- GIVEN an IClass SO matching task `t-1` with `generalStatus = 'open'`
- WHEN `IngestClosedServiceOrders` processes that SO
- THEN all existing side-effects apply (stage transition, activity, inventory)

---

### Requirement: REQ-GS-ICLASS-CLOSEDBY-FLOW-1 — IClass-closed tasks map to generalStatus='closed'

When the IClass closure flow transitions a task's stage to a `hecho`-category stage (via `REQ-MOVE-1`), the use case MUST also set `generalStatus = 'closed'` on the task. This keeps the management state consistent with the workflow outcome.

#### Scenario: IClass closure sets generalStatus to closed

- GIVEN task `t-1` has `generalStatus='open'`
- AND the IClass result-code maps to a `hecho`-category stage
- WHEN `IngestClosedServiceOrders` transitions `t-1`'s stage
- THEN `t-1.generalStatus` MUST equal `'closed'` after the transition
- AND a `status_changed` activity with `toValue='closed'` MUST be recorded with `actorId=null`, `actorName='System'`

---

### Requirement: REQ-GS-ICLASS-DISMISSED-SEMANTIC-1 — Dismissed in-flight task documentation

A task dismissed while its IClass SO is in-flight (stage = `registered_in_iclass`) is handled as follows:
- `listTasksInIClassStage` excludes it → no autocomplete or backfill reconciliation.
- `IngestClosedServiceOrders` mirrors the SO but skips task side-effects.
- The SO mirror row exists permanently; the task remains in `registered_in_iclass` stage unless manually moved.
- This is BY DESIGN: the operator discarded the task; no automated healing is performed.

#### Scenario: Dismissed in-flight task — no automated healing

- GIVEN task `t-1` has `generalStatus='dismissed'` AND `stageCode='registered_in_iclass'`
- WHEN any IClass closure loop runs (cron or manual backfill)
- THEN `t-1`'s stage MUST remain `'registered_in_iclass'`
- AND no stage transition or comment MUST be posted to `t-1`
