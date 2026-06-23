# Spec: ne8000-audit-page

**Capability**: `ne8000-audit-page`
**Type**: New frontend page (read-only)
**Change**: `network-audit-pages`
**Repo**: `ipnext-frontend` ← ⚠️ el código de esta capability vive en el repo FRONTEND, NO en este repo backend. El spec.md está aquí por convención SDD del proyecto (openspec en el backend).
**Page URL**: `/admin/networking/ne8000-audit`
**Backend API**: `GET /radius/ne8000/audit` (specced en `ne8000-audit-api`)
**Permission gate**: `network.read`
**UI skill**: `ui-ux-pro-max` (MANDATORY al implementar — leer el skill antes de escribir cualquier componente)

> READ-ONLY. Esta página muestra el padrón PPPoE del BRAS NE8000-1 con última conexión y estado.
> NO tiene botones de mutación. El flujo de corte/habilitación de PPPoE es out of scope para este EPIC.

---

## 1. Routing and Permission Gate

### REQ-ROUTE-1: Page is accessible at `/admin/networking/ne8000-audit`

**Given** the admin SPA navigation
**When** an authenticated user navigates to `/admin/networking/ne8000-audit`
**Then** the page MUST render with HTTP 200

### REQ-ROUTE-2: Route is gated by `RequirePermission('network.read')`

**Given** the existing `RequirePermission` component pattern
**When** a user without `network.read` navigates to `/admin/networking/ne8000-audit`
**Then** the `RequirePermission` component MUST redirect them to `/403` or render an access-denied state
**And** no `GET /radius/ne8000/audit` API call MUST be made for unauthorized users

#### Scenario: unauthorized user is blocked

**Given** a logged-in user without `network.read`
**When** they navigate to `/admin/networking/ne8000-audit`
**Then** they MUST see an access-denied message
**And** no NE8000 padrón data MUST be fetched or displayed

#### Scenario: authorized user sees the page

**Given** a logged-in user with `network.read`
**When** they navigate to `/admin/networking/ne8000-audit`
**Then** the page MUST render the audit table with data from `GET /radius/ne8000/audit`

---

## 2. Sidebar Entry

### REQ-SIDEBAR-1: "Auditoría NE8000" item added to "Gestión de Red" section

**Given** the `Sidebar.tsx` component in `ipnext-frontend`
**When** the sidebar renders for a user with `network.read`
**Then** a new item "Auditoría NE8000" (or "NE8000 Audit") MUST appear under "Gestión de Red"
**And** clicking it MUST navigate to `/admin/networking/ne8000-audit`
**And** the item MUST be gated by `requiredPermission: 'network.read'`

### REQ-SIDEBAR-2: Item does NOT appear for users without `network.read`

**Given** a user without `network.read`
**When** the sidebar renders
**Then** the "Auditoría NE8000" item MUST NOT be visible

---

## 3. Filter Panel

### REQ-FILTER-1: Filters are URL-backed (search params)

**Given** the `RecaptacionPage` / `TicketsListPage` pattern of URL-backed filters
**When** the user changes any filter
**Then** the page URL MUST update to reflect the active filters (e.g. `?username=c001&online=true`)
**And** reloading the page MUST restore the same filter state

### REQ-FILTER-2: Username search filter

**Given** the filter panel includes a username search field
**When** the user types a username (or substring)
**Then** the page MUST debounce (SHOULD be ~300ms) and call `GET /radius/ne8000/audit?username=<value>`
**And** the URL MUST reflect the filter as `?username=<value>`

### REQ-FILTER-3: PPPoE status filter

**Given** the filter panel includes a status selector
**When** the user selects a PPPoE status
**Then** accepted values MUST be: `enabled`, `disabled`, and "Todos" (no filter)
**And** the URL MUST reflect the filter as `?status=<value>`

### REQ-FILTER-4: Enforced state filter

**Given** the filter panel includes an enforced-state selector
**When** the user selects an enforced state
**Then** accepted values MUST be: `active`, `reduced`, `blocked`, and "Todos" (no filter)
**And** the URL MUST reflect the filter as `?enforcedState=<value>`

### REQ-FILTER-5: Online/offline toggle

**Given** the filter panel includes a connection toggle
**When** the user selects "Solo online"
**Then** the page MUST call `GET /radius/ne8000/audit?online=true`

**When** the user selects "Solo offline"
**Then** the page MUST call `GET /radius/ne8000/audit?online=false`

**And** "Todos" MUST be the default (no `online` param)

### REQ-FILTER-6: Clear all filters

**Given** one or more filters are active
**When** the user clicks "Limpiar filtros"
**Then** ALL filter values MUST be cleared
**And** the URL MUST revert to `/admin/networking/ne8000-audit`
**And** the table MUST reload with no filters applied

---

## 4. Audit Table

### REQ-TABLE-1: Table columns

**Given** the audit table on the page
**When** data loads from `GET /radius/ne8000/audit`
**Then** the table MUST display the following columns:

| Column | Source field | Notes |
|--------|-------------|-------|
| Usuario | `username` | |
| Perfil / Plan | `profile` | `—` if null |
| IP Fija | `remoteAddress` | `—` if null |
| IP Última Sesión | `lastFramedIp` | `—` if null |
| MAC | `macAddress` | `—` if null |
| VLAN | `lastVlanId` | `—` if null |
| Estado | `status` | Badge: `Habilitado` (green) / `Deshabilitado` (gray) |
| Corte | `enforcedState` | Badge: `Activo` / `Reducido` / `Bloqueado` |
| Conexión actual | `currentlyOnline` | Badge: `Online` (green) / `Offline` (gray) |
| Último inicio | `lastStartedAt` | Formatted local datetime, `—` if null |
| Último fin | `lastStoppedAt` | Formatted local datetime, `—` if null |
| Contrato | `contractId` | Shown as link if present: `/admin/contracts/<id>` (read link only) |

### REQ-TABLE-2: Loading state

**Given** the page is loading data from the API
**When** the API call is in-flight
**Then** the table MUST show a skeleton/loading state
**And** filters MUST remain accessible during loading

### REQ-TABLE-3: Empty state

**Given** the API returns `{ data: [], total: 0 }`
**When** the table renders
**Then** it MUST show an empty-state message (e.g. "No hay servicios PPPoE en el NE8000 para los filtros seleccionados")
**And** pagination MUST be hidden or disabled

### REQ-TABLE-4: Error state

**Given** the `GET /radius/ne8000/audit` call fails
**When** the page handles the error
**Then** it MUST show an error message with a retry button
**And** MUST NOT display stale data

---

## 5. Summary Header (opcional pero SHOULD)

### REQ-SUMMARY-1: Page SHOULD display aggregate counts

**Given** the full padrón may be large
**When** the page renders
**Then** it SHOULD display a summary bar showing:
- Total servicios en el NE8000
- Online ahora (`currentlyOnline = true`)
- Bloqueados (`enforcedState = 'blocked'`)
- Deshabilitados (`status = 'disabled'`)

**And** these counts SHOULD come from the same `GET /radius/ne8000/audit` response (`total` + filtered variants)
**And** this is SHOULD, not MUST — if implementation complexity is high, defer to Phase 2

---

## 6. Pagination

### REQ-PAGINATION-1: Uses the existing `Pagination` component

**Given** the `Pagination` component used by `RecaptacionPage` / `TicketsListPage`
**When** the audit table renders
**Then** it MUST use the same `Pagination` component
**And** changing pages MUST update the `?page=N` URL param

### REQ-PAGINATION-2: Page resets to 1 when filters change

**Given** the user is on page 2 of the audit
**When** they change any filter
**Then** the page MUST reset to page 1

---

## 7. No Mutation UI

### REQ-NOMUT-1: No create/edit/delete/cut controls exist

**Given** this page is read-only by design
**When** the page renders
**Then** there MUST be NO buttons that trigger PPPoE mutations
**And** specifically: no "Cortar", no "Bloquear", no "Habilitar", no "Deshabilitar" action buttons MUST appear
**And** the `network.manage` permission is not required and not checked anywhere on this page
**And** the contract link (if shown) is a read-only navigation link, not a mutation action

---

## 8. Relationship to Other Pages

### REQ-REL-1: This page does NOT replace the active-sessions page

**Given** `/admin/networking/radius-sessions` shows live active sessions
**When** this `ne8000-audit` page renders
**Then** it MUST show the PADRÓN (all PPPoE services on the NE8000, regardless of whether they are currently connected)
**And** the "Conexión actual" column enriches the padrón — it does NOT replace the sessions view
**And** the two pages are independent and MUST NOT conflict in the sidebar

---

## Appendix: API Dependency

This page depends entirely on `GET /radius/ne8000/audit` (specced in `ne8000-audit-api`).
The FE MUST NOT call any PPPoE mutation endpoints from this page.

FE file structure (reference pattern, design agent decides):
```
src/pages/networking/Ne8000AuditPage.tsx
src/pages/networking/Ne8000AuditPage.filters.ts  (URL param schema)
```
