# Delta for task-activity

**Capability**: `task-activity` (MODIFIED)
**Change**: `task-general-status` (#41)

---

## MODIFIED Requirements

### Requirement: REQ-MODEL-1 — Persistence (MODIFIED)

(Previously: `status_changed` event used `fromValue: prev.isClosed` and `toValue: data.isClosed` — boolean values. Watcher/field events unchanged.)

The system SHALL record activity for `generalStatus` transitions via the new `SetTaskGeneralStatus` use case. The `status_changed` event MUST carry string values (`'open' | 'closed' | 'dismissed'`). The existing boolean-payload events already persisted in the DB MUST be tolerated by the activity feed renderer (no backfill).

- WHEN user U calls `POST /api/scheduling/:id/status { status: 'closed' }`, THE SYSTEM SHALL persist one `status_changed` activity with `fromValue=<previous generalStatus>`, `toValue='closed'`.
- WHEN user U calls the endpoint to reopen a dismissed task, THE SYSTEM SHALL persist one `status_changed` with `fromValue='dismissed'`, `toValue='open'`.
- WHEN user U calls `PUT /:id { isClosed: true }` (legacy path), THE SYSTEM SHALL persist one `status_changed` activity using string values `fromValue=<prev generalStatus>`, `toValue='closed'`.
- WHEN the activity feed renders an older `status_changed` with boolean `fromValue`/`toValue`, THE renderer SHALL NOT crash — it MUST fall back gracefully (e.g. `true` → display as 'closed', `false` → 'open').
- All other activity types (priority_changed, stage_changed, etc.) are UNCHANGED.

#### Scenarios

- GIVEN task `t-1` has `generalStatus='open'`
- WHEN `POST /api/scheduling/t-1/status { status: 'dismissed' }` succeeds
- THEN a `status_changed` activity MUST be persisted with `fromValue='open'`, `toValue='dismissed'`
- AND `actorId` MUST equal the authenticated user's id

---

- GIVEN task `t-1` has `generalStatus='dismissed'`
- WHEN `POST /api/scheduling/t-1/status { status: 'open' }` succeeds
- THEN a `status_changed` activity MUST be persisted with `fromValue='dismissed'`, `toValue='open'`

---

- GIVEN the activity feed contains a legacy item with `type='status_changed'`, `fromValue=false`, `toValue=true`
- WHEN the feed renders that item
- THEN it MUST display without throwing a runtime error
- AND MAY show a fallback label (e.g. "cerró la tarea")

---

- GIVEN `PUT /api/scheduling/:id { isClosed: true }` (legacy caller)
- WHEN `UpdateTask` normalizes to `generalStatus='closed'` and emits activity
- THEN the `status_changed` activity MUST carry `toValue='closed'` (string, not boolean)
