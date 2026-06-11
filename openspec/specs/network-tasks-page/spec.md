# Network Tasks Page Specification

**Capability**: `network-tasks-page`
**Type**: New (no prior spec exists)
**Change**: `tareas-nodos-page` (#40)
**Route**: `/admin/scheduling/nodos`

---

## Purpose

Dedicated frontend page for `kind='network'` tasks. Operators see only node tasks here. "Añadir" opens the node-task modal directly without a mode toggle. Project select shows only projects flagged `isNetworkProject=true`.

---

## Requirements

### Requirement: REQ-NTP-1 — Page is accessible at `/admin/scheduling/nodos`

The system MUST register a route `/admin/scheduling/nodos` in `App.tsx` that renders `SchedulingNodeTasksPage`. The page MUST appear as a sidebar entry under the Scheduling section. The route MUST be gated: unauthenticated users MUST be redirected to login.

#### Scenario: Authenticated user with scheduling.read navigates to /admin/scheduling/nodos

- GIVEN a user with permission `scheduling.read`
- WHEN they navigate to `/admin/scheduling/nodos`
- THEN the page MUST render with title "Tareas Nodos"
- AND the task list MUST show only tasks with `kind='network'`

#### Scenario: User without scheduling.read cannot access the page

- GIVEN a user WITHOUT permission `scheduling.read`
- WHEN they navigate to `/admin/scheduling/nodos`
- THEN they MUST be denied access (redirect or 403 UI state)
- AND no task data MUST be displayed

---

### Requirement: REQ-NTP-2 — Page fetches only network tasks from the backend

The page MUST pass `kind='network'` as a fixed query parameter in all calls to `GET /api/scheduling`. This parameter MUST NOT be user-editable or appear in the URL. Omitting `kind` (i.e., navigating to `/admin/scheduling/tasks`) MUST NOT be affected.

#### Scenario: Page mounts and loads network tasks

- GIVEN the user is on `/admin/scheduling/nodos`
- WHEN the page mounts
- THEN `GET /api/scheduling?kind=network` MUST be called
- AND the response array MUST only contain tasks with `kind='network'`

#### Scenario: Filter combos kind+search

- GIVEN the user enters a search term on the Nodos page
- WHEN the filter is applied
- THEN the request MUST include BOTH `kind=network` AND the search param
- AND the `kind` param MUST remain fixed at `'network'`

#### Scenario: Filter combos kind+priority

- GIVEN the user selects a priority filter on the Nodos page
- WHEN the filter is applied
- THEN the request MUST include `kind=network&priority=<value>`

---

### Requirement: REQ-NTP-3 — "Añadir" opens node modal directly, no mode toggle

The "Añadir" button on `SchedulingNodeTasksPage` MUST open `CreateTaskModal` with `defaultMode='network'`. The mode toggle (segmented control) MUST NOT be visible in this context.

#### Scenario: Añadir button on Nodos page

- GIVEN the user is on `/admin/scheduling/nodos`
- AND has permission `scheduling.write`
- WHEN they click "Añadir"
- THEN `CreateTaskModal` MUST open in network mode
- AND the mode-toggle segmented control MUST be hidden
- AND `NodeSelector` MUST be visible immediately

#### Scenario: User without scheduling.write cannot open modal

- GIVEN a user with only `scheduling.read`
- WHEN on `/admin/scheduling/nodos`
- THEN the "Añadir" button MUST be absent or disabled

---

### Requirement: REQ-NTP-4 — Project select shows only network projects

The project dropdown inside `CreateTaskModal` on the Nodos page MUST be pre-filtered to only projects where `isNetworkProject=true`. The full unfiltered project list MUST NOT be shown.

#### Scenario: Project dropdown on node modal

- GIVEN `CreateTaskModal` is open in network mode on the Nodos page
- WHEN the user opens the project dropdown
- THEN only projects with `isNetworkProject=true` MUST appear
- AND projects with `isNetworkProject=false` MUST be absent

#### Scenario: No tagged projects — empty hint

- GIVEN no project in the system has `isNetworkProject=true`
- WHEN `CreateTaskModal` opens in network mode on the Nodos page
- THEN the project dropdown MUST show an empty state with a visible hint (e.g., "No hay proyectos de red configurados")
- AND the user MUST still be able to submit the form with no project selected

---

### Requirement: REQ-NTP-5 — Address pre-fills from selected NetworkSite

When the user selects a NetworkSite in `NodeSelector`, the address field MUST auto-fill with `NetworkSite.address` (if available). The field MUST remain editable.

#### Scenario: NetworkSite with address selected

- GIVEN the user selects a NetworkSite that has a non-null `address`
- WHEN the selection is made
- THEN the address input MUST be populated with `NetworkSite.address`
- AND the user MAY edit the value before submitting

#### Scenario: NetworkSite without address selected

- GIVEN the user selects a NetworkSite with `address: null`
- WHEN the selection is made
- THEN the address input MUST remain empty (not pre-filled)
- AND no error MUST be shown at selection time

---

### Requirement: REQ-NTP-6 — Client modal (Tareas page) excludes network projects

On `SchedulingTasksPage` (the existing `/admin/scheduling/tasks` page), `CreateTaskModal` MUST pass only projects where `isNetworkProject=false` to the project dropdown. Network projects MUST NOT appear in the customer task modal.

#### Scenario: Customer modal project dropdown excludes network projects

- GIVEN the user is on `/admin/scheduling/tasks` and opens "Añadir"
- WHEN the project dropdown is shown in customer mode
- THEN projects with `isNetworkProject=true` MUST be absent
- AND projects with `isNetworkProject=false` MUST be present

---

### Requirement: REQ-NTP-7 — Empty state for Nodos page task list

When no network tasks exist, the page MUST display a meaningful empty state (not a blank white area).

#### Scenario: No network tasks exist

- GIVEN `GET /api/scheduling?kind=network` returns `[]`
- WHEN the page renders
- THEN an empty state message MUST be visible (e.g., "No hay tareas de nodos")

---

## Wire Contract

| Endpoint | Param | Values | Notes |
|----------|-------|--------|-------|
| `GET /api/scheduling` | `kind` | `'network'` | Fixed on Nodos page; omitted on Tareas page |
| `GET /api/projects` | — | — | FE filters by `isNetworkProject` client-side |

Project DTO field required: `isNetworkProject: boolean` (see `projects` delta spec).
