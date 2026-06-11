# Spec: Scheduling Tasks Views

**Capability**: `scheduling-tasks-views` (new) + `scheduling` (filter delta)
**Change**: `scheduling-tasks-views`
**Routes (backend delta)**: `GET /api/scheduling` — filter extension
**Frontend route**: `/admin/scheduling/tasks`

---

## 1. Backend Filter Extension (delta to `scheduling` capability)

### REQ-FILTER-1: projectId filters by project

**Given** an authenticated `GET /api/scheduling?projectId=<id>` request
**When** tasks exist for that project and other projects
**Then** the server MUST respond with HTTP 200
**And** every task in the response array MUST have `projectId === <id>`
**And** tasks belonging to other projects MUST NOT appear in the response

### REQ-FILTER-2: stageIds filters to listed stages

**Given** an authenticated `GET /api/scheduling?stageIds[]=<id1>&stageIds[]=<id2>` request
**When** tasks exist in those stages and in other stages
**Then** the server MUST respond with HTTP 200
**And** every task in the response MUST have `stageId` in the provided stageIds set
**And** tasks in other stages MUST NOT appear

### REQ-FILTER-3: partnerId filters by partner

**Given** an authenticated `GET /api/scheduling?partnerId=<id>` request
**Then** the response MUST contain only tasks where `partnerId === <id>`

### REQ-FILTER-4: assigneeId filters by assignee

**Given** an authenticated `GET /api/scheduling?assigneeId=<id>` request
**Then** the response MUST contain only tasks where `assigneeId === <id>`

### REQ-FILTER-5: q performs case-insensitive title search

**Given** an authenticated `GET /api/scheduling?q=reparacion` request
**When** tasks exist with titles containing "reparacion" (any casing) and others that do not
**Then** the response MUST contain only tasks whose `title` contains "reparacion" (case-insensitive)
**And** tasks whose title does not match MUST NOT appear

### REQ-FILTER-6: Combining multiple params applies AND logic

**Given** an authenticated request with both `projectId=<p>` and `stageIds[]=<s>`
**Then** the response MUST contain only tasks where BOTH `projectId === <p>` AND `stageId` is in `<s>`

### REQ-FILTER-7: No filter params returns all tasks (backward compat) (MODIFIED)

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

### REQ-GS-VIEW-FILTER-1 — 4-option status filter in TaskFilterBar (both pages)

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

### REQ-GS-VIEW-ACTIONS-1 — Close / Dismiss / Reopen actions in task detail

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

### REQ-GS-VIEW-BADGE-1 — Status badge in detail and list whenever non-open

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

## 2. Backend Filter Validation

### REQ-LIST-FILTER-VAL-1: stageIds items must be non-empty strings

**Given** an authenticated `GET /api/scheduling?stageIds[]=` (empty string)
**When** the zod schema validates the query
**Then** the server MUST respond with HTTP 400
**And** the body MUST contain `{ "code": "VALIDATION_ERROR" }`

### REQ-LIST-FILTER-VAL-2: Unknown filter params are ignored

**Given** an authenticated `GET /api/scheduling?unknownParam=foo`
**Then** the server MUST respond with HTTP 200 and the full task list (unknown params stripped by zod `.strip()` default)

### REQ-LIST-FILTER-VAL-3: Filter validation does not use uuid format

**Given** any ID filter param (projectId, stageIds, partnerId, assigneeId)
**Then** the schema MUST validate with `z.string().min(1)` — NOT `z.string().uuid()`
**Note**: Project uses mixed ID formats (see lesson 3 from changes 1–5)

---

## 3. Frontend — Page and Route

### REQ-PAGE-1: Route renders SchedulingTasksPage

**Given** an authenticated user navigates to `/admin/scheduling/tasks`
**Then** `SchedulingTasksPage` MUST render without error
**And** the URL MUST remain `/admin/scheduling/tasks`
**And** the route MUST NOT conflict with the existing `/admin/scheduling/tasks/:id` route

### REQ-PAGE-2: Default view is Table

**Given** a user navigates to `/admin/scheduling/tasks` with no `?view=` param
**Then** the Table view MUST be rendered by default
**And** the "Vista de la tabla" toggle button MUST appear visually active

### REQ-PAGE-3: View toggle switches between Table and Kanban

**Given** the user clicks "Flujo de Trabajo" in the view toggle
**Then** the Table view MUST be replaced by the Kanban view
**And** the URL MUST update to include `?view=kanban`
**And** clicking "Vista de la tabla" MUST revert to the Table view and URL `?view=table`

### REQ-PAGE-4: Filter state persists in URL

**Given** a user applies a Project filter and a Stage filter
**When** the user copies the URL and opens it in a new tab
**Then** the same Project and Stage filters MUST be pre-applied
**And** the task list MUST reflect those filters

---

## 4. Table View

### REQ-TABLE-1: Renders DataTable with correct columns

**Given** the Table view is active
**Then** the following columns MUST be present (in order): Seq# / Stage / Project / Dirección / Cliente / Fecha inicio / Asignado / Prioridad / Edad / Acciones

### REQ-TABLE-2: Columns are sortable

**Given** the user clicks a column header in the table
**Then** the table MUST sort by that column (ascending first, then descending on second click)
**And** a sort direction indicator MUST appear next to the active sort column

### REQ-TABLE-3: Pagination controls are present

**Given** the table has more rows than the current page size
**Then** pagination controls MUST render below the table
**And** the user MUST be able to change page size (10 / 25 / 50 / 100)
**And** the current range (`Mostrando X al Y de Z`) MUST be displayed

### REQ-TABLE-4: Bulk select — checkbox column appears and rows are selectable

**Given** the Table view is active with `selectable` enabled
**Then** a checkbox column MUST appear as the first column
**And** checking a row checkbox MUST add it to the selection set
**And** checking the header checkbox MUST select all visible rows

### REQ-TABLE-5: Bulk action bar appears when ≥ 1 row is selected

**Given** at least one row is selected
**Then** a sticky bulk action bar MUST appear at the bottom of the viewport
**And** it MUST display the count of selected rows
**And** it MUST offer two actions: "Mover etapa" and "Eliminar"
**And** deselecting all rows MUST hide the bulk action bar

### REQ-TABLE-6: Bulk Move Stage opens a stage selector

**Given** rows are selected and the user clicks "Mover etapa"
**Then** a modal MUST open with a `<select>` listing all available stages
**And** confirming MUST call `PATCH /api/scheduling/:id/stage` for each selected task
**And** on completion the selection MUST be cleared and the task list MUST refresh

### REQ-TABLE-7: Row actions — Ver detalle navigates to task detail

**Given** the user clicks "Ver detalle" in a row's action menu
**Then** the browser MUST navigate to `/admin/scheduling/tasks/:id`

---

## 5. Kanban View

### REQ-KANBAN-1: Kanban requires a project to be selected

**Given** the Kanban view is active and no project filter is set
**Then** an empty state message MUST be displayed: "Seleccioná un proyecto para ver el Flujo de Trabajo"
**And** no columns MUST be rendered

### REQ-KANBAN-2: Columns are the stages of the selected project's workflow

**Given** the Kanban view is active and a project is selected
**When** the project's workflow is loaded via `useWorkflow(project.workflowId)`
**Then** one column MUST be rendered per stage in the workflow
**And** columns MUST appear in stage `order` ascending
**And** each column header MUST display the stage name and the count of cards in that column

### REQ-KANBAN-3: Cards display required fields

**Given** a Kanban column contains tasks
**Then** each card MUST display:
  - Sequence number (e.g. `#2886`)
  - Task title (truncated at 2 lines)
  - Priority pill (low / normal / high / urgent)
  - Assignee initials avatar (or "—" if none)
  - Age (e.g. "16 días", "6 horas")
  - Customer name or address (first available, truncated)

### REQ-KANBAN-4: Drag a card to another column moves its stage

**Given** the user drags a card from column A to column B using pointer or keyboard
**When** the drop completes
**Then** `PATCH /api/scheduling/:id/stage` MUST be called with `{ stageId: columnB.stageId }`
**And** the card MUST appear in column B optimistically before the server responds (AD-4)

### REQ-KANBAN-5: Failed stage move rolls back the card

**Given** the server returns a non-2xx response to `PATCH /api/scheduling/:id/stage`
**When** the `onError` callback fires
**Then** the query cache MUST be restored to the snapshot taken in `onMutate`
**And** the card MUST visually return to its original column

### REQ-KANBAN-6: Cards within a column are ordered by createdAt descending

**Given** a column contains multiple cards
**Then** cards MUST be displayed with the most recently created card at the top

### REQ-KANBAN-7: Empty column shows placeholder

**Given** a stage has no tasks
**Then** the column MUST still render with its header
**And** the body MUST display the text "Sin tareas en este estado"

---

## 6. URL Sync

### REQ-URL-SYNC-1: Filter changes update URL params with debounce

**Given** the user changes a filter value
**Then** the URL search params MUST update within 300ms
**And** the update MUST use `replace` (not `push`) to avoid polluting browser history

### REQ-URL-SYNC-2: View toggle updates URL immediately

**Given** the user clicks the view toggle button
**Then** `?view=table` or `?view=kanban` MUST be set in the URL immediately (no debounce)

### REQ-URL-SYNC-3: URL params are the source of truth on load

**Given** a user lands on the page with pre-existing URL params (e.g. `?projectId=x&view=kanban`)
**Then** the filter state MUST be initialised from those params
**And** the correct view MUST be active

### REQ-URL-SYNC-4: stageIds are encoded as repeated params

**Given** multiple stages are selected in the Stage filter
**Then** the URL MUST encode them as `?stageIds[]=a&stageIds[]=b` (repeated keys, bracket notation)
**And** the backend filter endpoint MUST accept the same format

---

## 7. Accessibility

### REQ-A11Y-1: Kanban board has ARIA landmark and column roles

**Given** the Kanban view is rendered
**Then** the board container MUST have `role="region"` with `aria-label="Flujo de Trabajo"`
**And** each column MUST have `role="group"` with `aria-label="<stage name> — <count> tareas"`

### REQ-A11Y-2: Kanban cards have draggable role

**Given** a Kanban card is rendered
**Then** the card element MUST have `aria-grabbed` managed by dnd-kit's `useDraggable`
**And** `tabIndex={0}` MUST be set so keyboard focus is possible

### REQ-A11Y-3: Keyboard drag is supported

**Given** a card has keyboard focus (Tab navigation)
**When** the user presses Space to pick up the card, arrow keys to navigate, and Space/Enter to drop
**Then** the card MUST be moved to the target column (dnd-kit KeyboardSensor handles this)

### REQ-A11Y-4: Priority pills have AA contrast

**Given** any priority pill is rendered on a card
**Then** the foreground/background colour pair MUST meet WCAG AA (≥ 4.5:1 for small text)
**And** the priority MUST also be communicated via `aria-label` (not colour alone)

### REQ-A11Y-5: View toggle uses `aria-pressed`

**Given** the view toggle buttons (Tabla / Flujo de Trabajo) are rendered
**Then** the active view's button MUST have `aria-pressed="true"`
**And** the inactive button MUST have `aria-pressed="false"`

---

## 8. Responsive Behaviour

### REQ-RESPONSIVE-1: Kanban scrolls horizontally below 1280px

**Given** the Kanban view is active and the viewport width is less than 1280px
**Then** the board container MUST have `overflow-x: auto`
**And** each column MUST have a minimum width of 240px (not collapsed)
**And** horizontal scrolling MUST be smooth (CSS `scroll-behavior: auto` or native momentum)

### REQ-RESPONSIVE-2: Table view adapts at 768px

**Given** the Table view is active at 768px viewport
**Then** less-critical columns (Address, Age) MAY be hidden via CSS `display: none` with a class applied at that breakpoint
**And** the table MUST remain horizontally scrollable if content overflows

### REQ-RESPONSIVE-3: Filter bar wraps on narrow viewports

**Given** the top filter bar is rendered at 768px or below
**Then** filter controls MUST wrap to multiple rows rather than overflow horizontally
**And** all filter controls MUST remain accessible and tappable (min 44px touch target)
