# Delta for scheduling-tasks-views

**Capability**: `scheduling-tasks-views` (MODIFIED)
**Change**: `task-general-status` (#41)

---

## ADDED Requirements

### Requirement: REQ-GS-VIEW-FILTER-1 — 4-option status filter in TaskFilterBar (both pages)

`TaskFilterBar` MUST add a status selector with four options: `open | closed | dismissed | todos`. Default on mount: `open`. Both `SchedulingTasksPage` (Tareas) and `SchedulingNodeTasksPage` (Tareas Nodos) MUST expose this filter via `TasksPageBase`. The selected value MUST be persisted in the URL as `?status=<value>` (`todos` maps to `?status=all`). On initial load with no `status` URL param, default MUST be `open`.

#### Scenario: Default filter on Tareas page

- GIVEN a user navigates to `/admin/scheduling/tasks` with no `status` URL param
- WHEN the page mounts
- THEN `useTasksFilterUrl` initializes `status='open'`
- AND `GET /api/scheduling?status=open&kind=...` is called
- AND the status selector shows "Abierta" as active

#### Scenario: Default filter on Nodos page

- GIVEN a user navigates to `/admin/scheduling/nodos` with no `status` URL param
- WHEN the page mounts
- THEN `GET /api/scheduling?kind=network&status=open` is called

#### Scenario: User selects "Todos"

- GIVEN the user selects "Todos" in the status filter
- WHEN the filter is applied
- THEN the URL updates to `?status=all`
- AND `GET /api/scheduling?status=all` is called
- AND closed and dismissed tasks appear in the list

#### Scenario: URL param persists status filter

- GIVEN the URL is `/admin/scheduling/tasks?status=closed`
- WHEN the page mounts
- THEN the status filter shows "Cerrada"
- AND only closed tasks are loaded

---

### Requirement: REQ-GS-VIEW-ACTIONS-1 — Close / Dismiss / Reopen actions in task detail

`TaskHeader` MUST expose actions based on current `generalStatus`, gated by `scheduling.write`:

| Current status | Actions shown |
|----------------|---------------|
| `open` | "Cerrar tarea", "Desestimar tarea" |
| `closed` | "Reabrir tarea", "Desestimar tarea" |
| `dismissed` | "Reabrir tarea", "Cerrar tarea" |

Each action calls `POST /api/scheduling/:id/status { status }`. On success the task detail MUST refresh and the list query MUST be invalidated.

#### Scenario: Close from detail (can write)

- GIVEN task `t-1` has `generalStatus='open'`
- AND user has `scheduling.write`
- WHEN user clicks "Cerrar tarea" in `TaskHeader`
- THEN `POST /api/scheduling/t-1/status { status: 'closed' }` is called
- AND the detail refreshes showing `generalStatus='closed'`

#### Scenario: Actions hidden without scheduling.write

- GIVEN user does NOT have `scheduling.write`
- WHEN task detail renders
- THEN no close/dismiss/reopen actions MUST be visible

#### Scenario: Reopen a dismissed task from detail

- GIVEN task `t-1` has `generalStatus='dismissed'`
- WHEN user clicks "Reabrir tarea"
- THEN `POST /api/scheduling/t-1/status { status: 'open' }` is called

---

### Requirement: REQ-GS-VIEW-BADGE-1 — Status badge in detail and list whenever non-open

Whenever `generalStatus !== 'open'`, `TaskHeader` and the `TasksTableView` row MUST display a status badge/pill indicating the current status (`closed` → "Cerrada", `dismissed` → "Descartada"). The badge is filter-independent: it renders under ANY filter, not only `all` (todos).

Rationale: the implemented rule shows the pill for any non-open task regardless of the active filter. Under a specific filter (e.g. `?status=closed`) the pill is redundant — every visible task is closed — but harmless, and it removes state ambiguity in mixed contexts (e.g. `?status=all`, deep-links, a row whose status changed in place after a bulk action). A purely filter-gated rule would hide the status exactly when it matters most. So the more permissive rule is the spec'd behaviour.

#### Scenario: Badge in detail for closed task when viewing "todos"

- GIVEN the filter is `?status=all`
- AND task `t-1` has `generalStatus='closed'`
- WHEN the task detail is opened
- THEN a badge "Cerrada" MUST be visible in `TaskHeader`

#### Scenario: Badge in list row for dismissed task when viewing "todos"

- GIVEN the filter is `?status=all`
- AND task `t-1` has `generalStatus='dismissed'`
- WHEN the task appears in `TasksTableView`
- THEN a "Descartada" pill MUST be rendered in the row

#### Scenario: Badge renders under a specific (non-all) filter too

- GIVEN the filter is `?status=closed`
- AND task `t-1` has `generalStatus='closed'`
- WHEN the task appears in `TasksTableView`
- THEN the "Cerrada" pill MUST still be rendered (redundant-but-harmless)

#### Scenario: No badge for open tasks

- GIVEN task `t-1` has `generalStatus='open'`
- WHEN rendered in any filter view
- THEN no status badge is shown (open is the normal state)

---

## MODIFIED Requirements

### Requirement: REQ-FILTER-7 — No filter params returns all tasks (MODIFIED)

(Previously: `GET /api/scheduling` with no query params returns all tasks, as the FE sent no `status` param)

The FE MUST now always send an explicit `status` parameter. The "Todos" option sends `?status=all`. The default view sends `?status=open`. The back-compat guarantee (omitted `status` ≡ all) is a BE contract for non-FE callers; the FE itself always sends explicit `status`.

#### Scenario: FE default always sends status=open

- GIVEN the Tareas page mounts with no URL params
- WHEN `buildFilterParams` serializes the filter
- THEN the resulting URL MUST include `status=open`

#### Scenario: Todos option sends status=all

- GIVEN the user selects "Todos" in the filter
- WHEN `buildFilterParams` serializes
- THEN the resulting URL MUST include `status=all`

---

## Deferred

- **Calendar status filtering**: the Calendar view is intentionally untouched by #41 and keeps its pre-existing all-statuses behaviour — dismissed (and closed) tasks still appear on the Calendar regardless of the `status` filter applied to the table/kanban views. This is a known, accepted gap, not a bug. Revisit only if operators report noise from dismissed tasks cluttering the Calendar; the fix would be to thread the same `generalStatus` filter through the Calendar query.
