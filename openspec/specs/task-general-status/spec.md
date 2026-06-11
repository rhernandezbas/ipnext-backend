# Spec: Task General Status Capability

**Capability**: `task-general-status`  
**Type**: New (domain abstraction of task lifecycle — open/closed/dismissed)  
**Change**: `task-general-status` (#41)  
**Routes**: `POST /api/scheduling/:id/status`  
**Frontend**: Status filter & actions in TasksPage and TaskDetail

---

## 1. Overview

The `task-general-status` capability introduces a **unified, human-centered view** of task lifecycle by abstracting the low-level `status` field (deprecated: pending/in_progress/completed/cancelled) into a high-level **generalStatus** with three states:

| generalStatus | Semantic | UI Label |
|---------------|----------|----------|
| `'open'` | Task is live and needs work | Abierta (default) |
| `'closed'` | Task completed or automatically transitioned by the system | Cerrada |
| `'dismissed'` | Operator intentionally discarded the task (no automated recovery) | Descartada |

The `isClosed` field is a derived boolean (`isClosed := generalStatus === 'closed'`) exposed for backwards compatibility.

---

## 2. Core Data Model

### REQ-SHAPE-1: ScheduledTask includes generalStatus and isClosed

Every `ScheduledTask` response MUST include:

```ts
interface ScheduledTask {
  // ... existing fields
  generalStatus: 'open' | 'closed' | 'dismissed';  // NEW
  isClosed: boolean;  // NEW, derived: generalStatus === 'closed'
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';  // Deprecated
}
```

**Scenario: Response shape includes new fields**

- GIVEN any authenticated request that returns a `ScheduledTask`
- WHEN the response is received
- THEN `generalStatus` MUST be one of `'open' | 'closed' | 'dismissed'`
- AND `isClosed` MUST equal `generalStatus === 'closed'`

---

## 3. Lifecycle API — Set Status Endpoint

### REQ-SET-STATUS-1: POST /api/scheduling/:id/status endpoint

A new endpoint `POST /api/scheduling/:id/status` (or reuse `PATCH`) MUST accept a `status` field with values `'open' | 'closed' | 'dismissed'` and:

1. **Validate**: Task exists (404 if not)
2. **Authorize**: User has `scheduling.write` permission (403 if not)
3. **Transition**: Update the task's `generalStatus` to the new value
4. **Record activity**: Emit a `status_changed` activity with string values (`fromValue`, `toValue`)
5. **Return**: Updated `ScheduledTask` with the new `generalStatus`

#### Scenario: Open → Closed transition

- GIVEN task `t-1` with `generalStatus='open'`
- AND user has `scheduling.write`
- WHEN `POST /api/scheduling/t-1/status { status: 'closed' }` succeeds
- THEN the task's `generalStatus` becomes `'closed'`
- AND `isClosed` becomes `true`
- AND a `status_changed` activity is recorded with `fromValue='open'`, `toValue='closed'`
- AND the response is HTTP 200

#### Scenario: Any → Dismissed transition (operator discard)

- GIVEN task `t-1` with `generalStatus='open'`
- WHEN `POST /api/scheduling/t-1/status { status: 'dismissed' }` succeeds
- THEN the task's `generalStatus` becomes `'dismissed'`
- AND `isClosed` becomes `false`
- AND the task is excluded from all automated IClass reconciliation loops (REQ-GS-ICLASS-DISMISSED-1)

#### Scenario: Permission gating

- GIVEN a user without `scheduling.write`
- WHEN they call `POST /api/scheduling/:id/status { status: 'closed' }`
- THEN the response is HTTP 403

#### Scenario: Invalid status value

- GIVEN a request with `{ status: 'archived' }`
- WHEN the endpoint is called
- THEN the response is HTTP 400 `{ code: 'VALIDATION_ERROR' }`

---

## 4. Task Closure Loop Integration

### REQ-GS-ICLASS-CLOSEDBY-FLOW-1: IClass-closed tasks auto-set generalStatus

When the IClass closure loop transitions a task to a `hecho`-category stage (REQ-MOVE-1 in iclass-closure-loop), it MUST also set `generalStatus = 'closed'` on the task to keep management state consistent.

**Scenario: IClass closure auto-closes task**

- GIVEN task `t-1` with `generalStatus='open'` in stage `'registered_in_iclass'`
- AND an IClass SO is closed with a result-code mapping to a `hecho` stage
- WHEN `IngestClosedServiceOrders` processes that SO
- THEN `t-1.generalStatus` becomes `'closed'`
- AND a `status_changed` activity is recorded with `actorId=null`, `actorName='System'`

---

## 5. Dismissed Task Semantics

### REQ-GS-ICLASS-DISMISSED-1: Dismissed tasks excluded from automation

When a task is set to `generalStatus='dismissed'`, it is removed from all automated reconciliation loops:

- `listTasksInIClassStage` filters out dismissed tasks (no stage moves, no inventory side-effects)
- `IngestClosedServiceOrders` skips side-effects on dismissed tasks (mirrors SO only, does not transition stage)
- `BackfillClosedServiceOrders` treats dismissed tasks as ineligible for autocompletion

**Rationale**: Dismissing a task means the operator intentionally discarded it. Continuing to move its stage or post comments would contradict that choice.

**Scenario: Dismissed in-flight task remains untouched**

- GIVEN task `t-1` with `generalStatus='dismissed'` and `stageCode='registered_in_iclass'`
- WHEN the IClass closure loop runs
- THEN `t-1`'s stage MUST remain `'registered_in_iclass'`
- AND no activities are posted to `t-1`
- AND the SO mirror row is still persisted (audit trail preserved)

---

## 6. Activity Log Integration

### REQ-ACTIVITY-1: status_changed events carry string values

When a task's `generalStatus` is changed via any path (manual via `POST /api/scheduling/:id/status` or automated via IClass closure), the resulting `status_changed` activity MUST carry **string values**:

```ts
activity {
  type: 'status_changed',
  fromValue: 'open' | 'closed' | 'dismissed',
  toValue: 'open' | 'closed' | 'dismissed',
  actorId: string | null,  // null for system-triggered (IClass)
  actorName: string,       // 'System' for automated
}
```

**Legacy compatibility**: Old activities with boolean `fromValue`/`toValue` (from pre-generalStatus releases) MUST render without crashing; the feed renderer falls back gracefully (e.g., `true` → "cerró la tarea", `false` → "reabrió la tarea").

---

## 7. Frontend — Status Filter

### REQ-GS-VIEW-FILTER-1: Status filter in TaskFilterBar

`TaskFilterBar` MUST add a status selector with four options and their labels:

| Value | Label |
|-------|-------|
| `'open'` | Abierta |
| `'closed'` | Cerrada |
| `'dismissed'` | Descartada |
| `'all'` (maps to `?status=all` in URL) | Todos |

**Default behavior:**
- On initial page load with NO `status` URL param → default to `'open'`
- The selected value persists in the URL as `?status=<value>`
- `'all'` maps to `?status=all` in the URL (sent to backend as `all`)

**Both pages must support it:**
- `/admin/scheduling/tasks` (Tareas — customer and network mixed)
- `/admin/scheduling/nodos` (Tareas Nodos — network tasks filtered by `kind=network`)

**Scenario: Default filter on mount**

- GIVEN a user navigates to `/admin/scheduling/tasks` with no URL params
- WHEN the page mounts
- THEN `useTasksFilterUrl` initializes `status='open'`
- AND `GET /api/scheduling?status=open` is called
- AND the status selector shows "Abierta" as active

**Scenario: Todos shows all statuses**

- GIVEN the user selects "Todos"
- WHEN the URL updates to `?status=all`
- THEN `GET /api/scheduling?status=all` is called
- AND tasks with all three generalStatus values appear

---

## 8. Frontend — Task Actions

### REQ-GS-VIEW-ACTIONS-1: Context-aware status actions

`TaskHeader` (task detail view) MUST expose status actions based on the current `generalStatus`. Actions are only visible if the user has the `scheduling.write` permission.

| Current Status | Actions Shown |
|---|---|
| `open` | "Cerrar tarea" (→ closed), "Desestimar tarea" (→ dismissed) |
| `closed` | "Reabrir tarea" (→ open), "Desestimar tarea" (→ dismissed) |
| `dismissed` | "Reabrir tarea" (→ open), "Cerrar tarea" (→ closed) |

Each action triggers `POST /api/scheduling/:id/status { status: '<new-status>' }`. On success, the task detail view and the list query both refresh.

**Scenario: Close from detail**

- GIVEN task `t-1` with `generalStatus='open'`
- AND user has `scheduling.write`
- WHEN user clicks "Cerrar tarea"
- THEN `POST /api/scheduling/t-1/status { status: 'closed' }` is called
- AND detail and list both update

**Scenario: Reopen a dismissed task**

- GIVEN task `t-1` with `generalStatus='dismissed'`
- WHEN user clicks "Reabrir tarea"
- THEN `POST /api/scheduling/t-1/status { status: 'open' }` is called

**Scenario: Actions hidden without permission**

- GIVEN user does NOT have `scheduling.write`
- WHEN task detail renders
- THEN no status action buttons are visible

---

## 9. Frontend — Status Badge

### REQ-GS-VIEW-BADGE-1: Status badge in list and detail

Whenever a task has `generalStatus !== 'open'` (i.e., closed or dismissed), a **status badge/pill MUST appear** in:

1. The task detail header (`TaskHeader`)
2. The list view table row (`TasksTableView`)

**Badge labels:**
- `closed` → "Cerrada" (red/error color)
- `dismissed` → "Descartada" (gray/neutral color)

**Rendering rule**: The badge renders regardless of which status filter is active. Under a specific filter (e.g., `?status=closed`) the badge is redundant but harmless; under an `all` filter or in deep-link scenarios, it provides critical context.

**Scenario: Badge in detail under any filter**

- GIVEN task `t-1` with `generalStatus='closed'`
- AND the filter is `?status=all` (or any other filter)
- WHEN the task detail is opened
- THEN a "Cerrada" badge MUST be visible in `TaskHeader`

**Scenario: Badge in list row**

- GIVEN task `t-1` with `generalStatus='dismissed'`
- WHEN the task appears in the table
- THEN a "Descartada" pill MUST be rendered in the row

---

## 10. Backwards Compatibility & Migration

### REQ-COMPAT-1: Legacy isClosed field

Existing code that references the boolean `isClosed` field MUST continue to work:

```ts
task.isClosed === true  // equivalent to: task.generalStatus === 'closed'
```

Tasks created or updated before `task-general-status` rolls out are backfilled with:
- `generalStatus = 'open'` (default for all pre-existing tasks)
- `isClosed = false` (unless the task was previously closed, in which case `generalStatus = 'closed'`, `isClosed = true`)

### REQ-COMPAT-2: Legacy UpdateTask.execute behavior

The `PUT /api/scheduling/:id` route MUST continue to accept the old-style `{ isClosed: true }` update. When received:
1. Map `isClosed: true` → `generalStatus: 'closed'` internally
2. Record a `status_changed` activity with string values (not boolean)
3. Return the updated task with both `isClosed` and `generalStatus` fields

---

## 11. Deferred / Known Gaps

### Calendar View Status Filtering

The Calendar view is intentionally untouched by #41. Dismissed (and closed) tasks still appear on the Calendar regardless of the status filter applied to the Table/Kanban views. This is a known, accepted gap — the fix would thread the same `generalStatus` filter through the Calendar query. Revisit only if operators report dismissed tasks cluttering the Calendar view.

---

## Appendix: Test Scenarios Summary

| Path | Input | Expected Behavior |
|------|-------|-------------------|
| `POST /api/scheduling/:id/status` | `{ status: 'closed' }` | Task closes, activity logged |
| `POST /api/scheduling/:id/status` | `{ status: 'dismissed' }` | Task dismissed, excluded from IClass loops |
| `POST /api/scheduling/:id/status` | `{ status: 'invalid' }` | HTTP 400 VALIDATION_ERROR |
| `GET /api/scheduling?status=open` | — | Return only open tasks |
| `GET /api/scheduling?status=closed` | — | Return only closed tasks |
| `GET /api/scheduling?status=all` | — | Return all tasks (no filtering) |
| FE: Status filter init | No URL param | Default to `status=open`, query called |
| FE: Status actions | User has permission | Buttons visible, actions work |
| FE: Status badge | Task not open | Badge renders in detail & list |
| IClass closure → task | Task in hecho stage | Task auto-sets `generalStatus='closed'` |
| Dismissed task in flight | IClass runs | SO mirrored, task stage unchanged |
