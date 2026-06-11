# task-general-status Specification

**Capability**: `task-general-status` (NEW)
**Change**: `task-general-status` (#41)

## Purpose

Lifecycle management state for `ScheduledTask`, independent of workflow stage. Three values: `open` (default), `closed`, `dismissed`. Driven by a new `generalStatus` column; `isClosed` becomes a read-only facade derived from it.

---

## Requirements

### Requirement: REQ-GS-MODEL-1 — `generalStatus` column and `isClosed` facade

`ScheduledTask` MUST add `generalStatus String @default("open")` (values: `open | closed | dismissed`). The domain entity MUST expose `generalStatus: 'open' | 'closed' | 'dismissed'`. `isClosed: boolean` MUST be derived on read (`generalStatus === 'closed'`) in both `toTask` mappers; the DB column `isClosed` MUST be synced on write (one line per repo) only for ops tooling. No read path may use the `isClosed` DB column.

#### Scenario: New task defaults to open

- GIVEN a task is created via `POST /api/scheduling`
- WHEN no `generalStatus` is provided
- THEN `task.generalStatus` MUST equal `'open'`
- AND `task.isClosed` MUST equal `false`

#### Scenario: isClosed facade for closed task

- GIVEN a task has `generalStatus = 'closed'`
- WHEN `toTask` maps the DB row
- THEN `task.isClosed` MUST be `true`
- AND the `isClosed` DB column is NOT used for this derivation

#### Scenario: isClosed facade for dismissed task

- GIVEN a task has `generalStatus = 'dismissed'`
- WHEN `toTask` maps the DB row
- THEN `task.isClosed` MUST be `false`

---

### Requirement: REQ-GS-MIGRATION-1 — Additive migration + idempotent backfill

The migration MUST be additive: `ALTER TABLE "ScheduledTask" ADD COLUMN IF NOT EXISTS "generalStatus" TEXT NOT NULL DEFAULT 'open'`. The same migration file MUST append an idempotent `UPDATE "ScheduledTask" SET "generalStatus"='closed' WHERE "isClosed"=true AND "generalStatus" <> 'closed'`. The `<> 'closed'` predicate (rather than `= 'open'`) is intentional: it is idempotent AND never clobbers a row already correctly closed, so re-running the migration is always safe.

#### Scenario: Backfill correctness

- GIVEN N tasks exist with `isClosed=true` before migration
- WHEN the migration runs
- THEN exactly those N tasks MUST have `generalStatus='closed'`
- AND all other tasks MUST have `generalStatus='open'`

---

### Requirement: REQ-GS-ENDPOINT-1 — `POST /api/scheduling/:id/status`

The system MUST expose `POST /api/scheduling/:id/status` gated by `auth` + `scheduling.write`. Body: `{ status: 'open' | 'closed' | 'dismissed' }`. On success: HTTP 200 with the updated `ScheduledTask` DTO. Transitions are free: any value may transition to any other value.

| Condition | HTTP | code |
|-----------|------|------|
| Task not found | 404 | `TASK_NOT_FOUND` |
| Invalid `status` value (zod) | 400 | `VALIDATION_ERROR` |
| Missing `status` field (zod) | 400 | `VALIDATION_ERROR` |
| Defensive invalid status (use-case, post-zod) | 422 | `INVALID_GENERAL_STATUS` |
| Unauthenticated | 401 | `UNAUTHORIZED` |
| No `scheduling.write` | 403 | `FORBIDDEN` |

**Note**: the route's zod guard (`z.enum`) rejects bad/missing `status` with **400 `VALIDATION_ERROR`** (matches the frozen wire contract and the implementation). The **422 `INVALID_GENERAL_STATUS`** path is the use-case's defensive validation, unreachable through the HTTP route once zod passes, but kept for direct use-case callers.

#### Scenario: Close a task

- GIVEN task `t-1` exists with `generalStatus='open'`
- WHEN `POST /api/scheduling/t-1/status { status: 'closed' }` (authenticated, scheduling.write)
- THEN response is HTTP 200
- AND `response.generalStatus` equals `'closed'`
- AND `response.isClosed` equals `true`
- AND a `status_changed` activity is recorded

#### Scenario: Dismiss a task

- GIVEN task `t-1` exists with `generalStatus='open'`
- WHEN `POST /api/scheduling/t-1/status { status: 'dismissed' }`
- THEN response is HTTP 200
- AND `response.generalStatus` equals `'dismissed'`
- AND `response.isClosed` equals `false`

#### Scenario: Reopen a dismissed task

- GIVEN task `t-1` has `generalStatus='dismissed'`
- WHEN `POST /api/scheduling/t-1/status { status: 'open' }`
- THEN response is HTTP 200
- AND `response.generalStatus` equals `'open'`
- AND a `status_changed` activity is recorded with `toValue='open'`

#### Scenario: Dismiss an already-closed task

- GIVEN task `t-1` has `generalStatus='closed'`
- WHEN `POST /api/scheduling/t-1/status { status: 'dismissed' }`
- THEN response is HTTP 200 (free transitions allowed)
- AND `response.generalStatus` equals `'dismissed'`

#### Scenario: Invalid status value

- GIVEN task `t-1` exists
- WHEN `POST /api/scheduling/t-1/status { status: 'archived' }`
- THEN response is HTTP 400 `{ code: 'VALIDATION_ERROR' }` (rejected by the route's zod `z.enum` guard)

#### Scenario: Task not found

- GIVEN no task with id `x-99` exists
- WHEN `POST /api/scheduling/x-99/status { status: 'closed' }`
- THEN response is HTTP 404 `{ code: 'TASK_NOT_FOUND' }`

---

### Requirement: REQ-GS-UPDATE-NORMALIZE-1 — `UpdateTask` normalizes `isClosed` to `generalStatus`

`PUT /api/scheduling/:id` continues to accept `{ isClosed: true/false }`. `UpdateTask` use case MUST normalize: `isClosed:true → generalStatus:'closed'`, `isClosed:false → generalStatus:'open'`. When both `isClosed` and explicit `generalStatus` are present in the same body, `generalStatus` wins.

#### Scenario: PUT with isClosed:true maps to closed

- GIVEN task `t-1` has `generalStatus='open'`
- WHEN `PUT /api/scheduling/t-1 { isClosed: true }`
- THEN `task.generalStatus` MUST equal `'closed'`
- AND the 12 existing isClosed tests MUST remain green via facade

#### Scenario: PUT with explicit generalStatus wins over isClosed

- GIVEN task `t-1` has `generalStatus='open'`
- WHEN `PUT /api/scheduling/t-1 { isClosed: true, generalStatus: 'dismissed' }`
- THEN `task.generalStatus` MUST equal `'dismissed'`

---

### Requirement: REQ-GS-DTO-1 — Task DTO exposes `generalStatus` and `isClosed`

Every `ScheduledTask` response MUST include:

| Field | Type | Source |
|-------|------|--------|
| `generalStatus` | `'open' \| 'closed' \| 'dismissed'` | DB column |
| `isClosed` | `boolean` | Derived: `generalStatus === 'closed'` |

#### Scenario: DTO fields present in list response

- GIVEN task `t-1` has `generalStatus='dismissed'`
- WHEN `GET /api/scheduling` is called
- THEN `t-1` in the response array MUST have `generalStatus='dismissed'` AND `isClosed=false`
