# Spec: radius-logs-page

**Capability**: `radius-logs-page`
**Type**: New frontend page (read-only)
**Change**: `network-audit-pages`
**Repo**: `ipnext-frontend` ← ⚠️ el código de esta capability vive en el repo FRONTEND, NO en este repo backend. El spec.md está aquí por convención SDD del proyecto (openspec en el backend).
**Page URL**: `/admin/networking/radius-logs`
**Backend API**: `GET /radius/events` (specced en `radius-events-query-api`)
**Permission gate**: `network.read`
**UI skill**: `ui-ux-pro-max` (MANDATORY al implementar — leer el skill antes de escribir cualquier componente)

> READ-ONLY. Esta página NO tiene botones de mutación. Ningún escenario de este spec involucra
> crear, editar, eliminar o modificar sesiones PPPoE. Es pura observabilidad.

---

## 1. Routing and Permission Gate

### REQ-ROUTE-1: Page is accessible at `/admin/networking/radius-logs`

**Given** the admin SPA navigation
**When** an authenticated user navigates to `/admin/networking/radius-logs`
**Then** the page MUST render with HTTP 200

### REQ-ROUTE-2: Route is gated by `RequirePermission('network.read')`

**Given** the existing `RequirePermission` component pattern (used by `/admin/networking/radius-sessions`)
**When** a user without `network.read` navigates to `/admin/networking/radius-logs`
**Then** the `RequirePermission` component MUST redirect them to `/403` or render an access-denied state
**And** no `GET /radius/events` API call MUST be made for unauthorized users

#### Scenario: unauthorized user is blocked

**Given** a logged-in user without `network.read`
**When** they navigate to `/admin/networking/radius-logs`
**Then** they MUST see an access-denied message
**And** no RADIUS data MUST be fetched or displayed

#### Scenario: authorized user sees the page

**Given** a logged-in user with `network.read`
**When** they navigate to `/admin/networking/radius-logs`
**Then** the page MUST render the logs table with data from `GET /radius/events`

---

## 2. Sidebar Entry

### REQ-SIDEBAR-1: "Logs RADIUS" item added to "Gestión de Red" section

**Given** the `Sidebar.tsx` component in `ipnext-frontend`
**When** the sidebar renders for a user with `network.read`
**Then** a new item "Logs RADIUS" (or "RADIUS Logs") MUST appear under "Gestión de Red"
**And** clicking it MUST navigate to `/admin/networking/radius-logs`
**And** the item MUST be gated by `requiredPermission: 'network.read'` (hidden for users without it)

### REQ-SIDEBAR-2: Item does NOT appear for users without `network.read`

**Given** a user without `network.read`
**When** the sidebar renders
**Then** the "Logs RADIUS" item MUST NOT be visible in the sidebar

---

## 3. Filter Panel

### REQ-FILTER-1: Filters are URL-backed (search params)

**Given** the `RecaptacionPage` / `TicketsListPage` pattern of URL-backed filters
**When** the user changes any filter
**Then** the page URL MUST update to reflect the active filters (e.g. `?username=c001&eventType=stop`)
**And** reloading the page MUST restore the same filter state
**And** sharing the URL MUST reproduce the same filtered view

### REQ-FILTER-2: Username / text search filter

**Given** the filter panel
**When** the user types in the username search field
**Then** the page MUST debounce the input (SHOULD be ~300ms) and call `GET /radius/events?username=<value>`
**And** the filter MUST be reflected in the URL as `?username=<value>`

### REQ-FILTER-3: NAS selector filter

**Given** the filter panel includes a NAS dropdown
**When** the user selects a specific NAS server
**Then** the page MUST call `GET /radius/events?nasId=<uuid>`
**And** the dropdown MUST be populated from a separate `GET /nas-servers` or equivalent endpoint
**And** "Todos los NAS" (All NAS) MUST be the default (no filter applied)

### REQ-FILTER-4: VLAN filter

**Given** the filter panel includes a VLAN input
**When** the user enters a VLAN ID (integer)
**Then** the page MUST call `GET /radius/events?vlanId=<integer>`
**And** non-integer input MUST show a validation error inline and NOT trigger an API call

### REQ-FILTER-5: Event type filter

**Given** the filter panel includes an event type selector
**When** the user selects an event type
**Then** accepted values MUST be: `start`, `stop`, `interim`, and "Todos" (no filter)
**And** selecting "Todos" MUST remove the `eventType` param from the URL

### REQ-FILTER-6: Date range filter

**Given** the filter panel includes `from` and `to` date pickers
**When** the user selects a date range
**Then** the page MUST call `GET /radius/events?from=<ISO>&to=<ISO>`
**And** selecting only `from` (no `to`) MUST be valid
**And** `to` before `from` MUST show an inline validation error

### REQ-FILTER-7: Online/offline toggle

**Given** the filter panel includes a toggle for session status
**When** the user toggles "Solo online" (active sessions)
**Then** the page MUST call `GET /radius/events?online=true`
**And** toggling "Solo offline" MUST call `GET /radius/events?online=false`
**And** "Todos" MUST be the default (no `online` param)

### REQ-FILTER-8: Clear all filters

**Given** one or more filters are active
**When** the user clicks "Limpiar filtros" (or equivalent)
**Then** ALL filter values MUST be cleared
**And** the URL MUST revert to `/admin/networking/radius-logs` (no query params)
**And** the table MUST reload with no filters applied

---

## 4. Events Table

### REQ-TABLE-1: Table columns

**Given** the events table on the page
**When** data loads from `GET /radius/events`
**Then** the table MUST display the following columns:

| Column | Source field | Notes |
|--------|-------------|-------|
| Usuario | `username` | |
| IP Asignada | `framedIp` | `—` if null |
| MAC | `macAddress` | `—` if null |
| VLAN | `vlanId` | `—` if null |
| NAS | `nasName` | From DTO, not raw IP |
| Inicio | `startedAt` | Formatted local datetime |
| Fin | `stoppedAt` | `En curso` badge if null |
| Duración | `sessionTime` | Formatted as `Xh Ym` |
| Tipo | `eventType` | Badge: `start` / `stop` / `interim` |
| Estado | `online` | Badge: `Online` (green) / `Offline` (gray) |

**And** clicking a column header SHOULD NOT sort (server-side sorting is out of scope for Phase 1)

### REQ-TABLE-2: Loading state

**Given** the page is loading data from the API
**When** the API call is in-flight
**Then** the table MUST show a skeleton/loading state
**And** the filter controls MUST remain accessible during loading

### REQ-TABLE-3: Empty state

**Given** the API returns `{ data: [], total: 0 }`
**When** the table renders
**Then** it MUST show an empty-state message (e.g. "No hay eventos para los filtros seleccionados")
**And** the pagination MUST be hidden or disabled

### REQ-TABLE-4: Error state

**Given** the `GET /radius/events` call fails (network error or 5xx)
**When** the page handles the error
**Then** it MUST show an error message with a retry button
**And** MUST NOT show stale data from a previous successful load

---

## 5. Pagination

### REQ-PAGINATION-1: Uses the existing `Pagination` component

**Given** the `Pagination` component used by `RecaptacionPage` / `TicketsListPage`
**When** the events table renders
**Then** it MUST use the same `Pagination` component with `total`, `page`, `limit` props
**And** changing pages MUST update the `?page=N` URL param
**And** changing the limit (if the Pagination component supports it) MUST update `?limit=N`

### REQ-PAGINATION-2: Page resets to 1 when filters change

**Given** the user is on page 3
**When** they change any filter
**Then** the page MUST reset to page 1 (remove `?page=N` or set `?page=1`)
**And** an API call MUST be triggered with `page=1` and the new filter

---

## 6. No Mutation UI

### REQ-NOMUT-1: No create/edit/delete buttons exist

**Given** this page is read-only by design
**When** the page renders
**Then** there MUST be NO buttons, links, or controls that trigger PPPoE mutations
**And** specifically: no "Desconectar", no "Bloquear", no "Editar", no "Eliminar" controls MUST appear
**And** the `network.manage` permission is not required and not checked anywhere on this page

---

## Appendix: API Dependency

This page depends entirely on `GET /radius/events` (specced in `radius-events-query-api`).
The FE MUST NOT call any RADIUS mutation endpoints from this page.

FE file structure (reference pattern, design agent decides):
```
src/pages/networking/RadiusLogsPage.tsx
src/pages/networking/RadiusLogsPage.filters.ts  (URL param schema)
```
