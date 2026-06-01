# Spec: Scheduling Task Detail (frontend capability)

## Capability

The admin can open, inspect, edit, move, and delete a single `ScheduledTask` from a dedicated detail page at `/admin/scheduling/tasks/:id` in the `ipnext-frontend` SPA. The page is the day-to-day workspace for field operations and surfaces every field the post-change-3 backend exposes.

RFC 2119 keywords (MUST, SHOULD, MAY) are normative.

## Requirements

### REQ-PAGE-1 — Page loads from route param

**Given** an authenticated admin
**When** they navigate to `/admin/scheduling/tasks/:id` where `:id` matches an existing `ScheduledTask.id`
**Then** the page MUST issue `GET /api/scheduling/:id` once and render the task with all sections populated.

### REQ-PAGE-2 — 404 task

**Given** an authenticated admin
**When** they navigate to `/admin/scheduling/tasks/:id` where `:id` does not match any task (backend returns 404 `TASK_NOT_FOUND`)
**Then** the page MUST render a friendly empty state "Tarea no encontrada" with a "Volver a Scheduling" link to `/admin/scheduling/projects`. The page MUST NOT throw or unmount the app.

### REQ-PAGE-3 — Unauthenticated redirect

**Given** an unauthenticated visitor
**When** they navigate to `/admin/scheduling/tasks/:id`
**Then** they MUST be redirected to `/login` by the existing `ProtectedRoute` wrapper. No `GET /:id` request is issued.

### REQ-PAGE-4 — Sections rendered

The page MUST render the following sections in this order at viewport ≥ 1280 px:
1. Sticky header (title editable, stage selector, priority selector, kebab menu).
2. Main column: Datos form, Ubicación map, Descripción editor, Lista de verificación (placeholder).
3. Sidebar column: Customer card, Service card, Reporter card, Watchers chip list.

At viewport < 1024 px, sidebar cards MUST flow below the main column in the same order (Customer, Service, Reporter, Watchers).

### REQ-EDIT-1 — In-place title edit

**Given** the page is rendered
**When** the admin clicks the title
**Then** the title MUST become an `<input>` focused with current value selected.
**When** the admin presses Enter or blurs with a changed value
**Then** the page MUST optimistically update the visible title and issue `PUT /api/scheduling/:id` with `{ title: <new> }`. On error, the title MUST revert to the previous value and an inline error MUST appear next to the title.
**When** the admin presses Escape
**Then** the input MUST close discarding changes.

### REQ-EDIT-2 — Description editor

**Given** the page is rendered
**When** the admin focuses the description editor and edits content (bold, italic, ordered list, unordered list, link)
**Then** an explicit "Guardar" button MUST become enabled.
**When** the admin clicks "Guardar"
**Then** the page MUST issue `PUT /api/scheduling/:id` with `{ description: <html> }` and disable the button while saving. On success, an ARIA-live region MUST announce "Descripción guardada".

### REQ-EDIT-3 — Datos form

**Given** the page is rendered
**When** the admin edits any field in the Datos form (project, assignee, partner, customer, service, startDate, endDate, travelTimeTo, travelTimeFrom)
**Then** the form MUST be marked dirty (visible indicator).
**When** the admin clicks "Guardar cambios"
**Then** the page MUST issue a single `PUT /api/scheduling/:id` with all changed fields. On error, the form MUST stay dirty and an inline error MUST appear.

### REQ-EDIT-4 — Dirty state on navigation

**Given** the Datos form or description editor is dirty
**When** the admin attempts to navigate away (link click or browser back)
**Then** the page MUST show a confirmation prompt "Tienes cambios sin guardar. ¿Salir igual?". On cancel, navigation MUST be blocked.

### REQ-STAGE-MOVE-1 — Stage selector

**Given** the page is rendered and the task's workflow has stages
**When** the admin selects a different stage in the header dropdown
**Then** the page MUST optimistically update the visible stage pill and issue `PATCH /api/scheduling/:id/stage` with `{ stageId: <new> }`. On error, the pill MUST revert and a toast MUST display the error code from the response.

### REQ-STAGE-MOVE-2 — Stage colour by category

The stage pill in the header MUST be coloured according to `stageCategory`:
- `nuevo` — blue (#2563EB on light, #60A5FA on dark)
- `enProgreso` — amber (#D97706 / #FBBF24)
- `hecho` — green (#059669 / #34D399)
- `cancelado` — slate (#64748B / #94A3B8)

All four palette pairs MUST meet WCAG AA contrast against the pill background.

### REQ-WATCHERS-1 — Add watcher

**Given** the watchers section is rendered
**When** the admin clicks "Añadir watcher", searches an admin by name, and selects one
**Then** the page MUST issue `PUT /api/scheduling/:id` with `{ watcherIds: [...existing, <newId>] }` (full replace-set array). On success, the new watcher chip MUST appear.

### REQ-WATCHERS-2 — Remove watcher

**Given** at least one watcher chip is rendered
**When** the admin clicks the X on a watcher chip
**Then** the page MUST issue `PUT /api/scheduling/:id` with `{ watcherIds: <existing minus removed> }`. On success, the chip MUST disappear.

### REQ-WATCHERS-3 — Search admin

**Given** the add-watcher popover is open
**When** the admin types in the search input
**Then** the popover MUST debounce 300 ms and call `GET /api/admins` (filtered client-side if backend lacks `?q=`). Results MUST exclude admins already in `watcherIds`.

### REQ-LOCATION-1 — Map renders coordinates

**Given** the task has non-null lat/lng (coordinates)
**When** the page renders
**Then** the Leaflet map MUST display at zoom 16 centered on the lat/lng with a draggable marker at that position.

### REQ-LOCATION-2 — Map empty state

**Given** the task has null coordinates
**When** the page renders
**Then** the Ubicación section MUST show a placeholder card with the empty-state message "Sin ubicación. Introduce una dirección o pincha en el mapa." and a centered-on-Argentina default map (lat -34.6, lng -58.4, zoom 5).

### REQ-LOCATION-3 — Address-to-map (geocode)

**Given** the address `<input>` is focused
**When** the admin types an address and blurs (or hits Enter)
**Then** the page MUST debounce 600 ms and call Nominatim (`https://nominatim.openstreetmap.org/search`) with the address. On success, the map marker MUST recenter and the form's lat/lng MUST update. On no-result, an inline message "Sin resultados para esa dirección" MUST appear.

### REQ-LOCATION-4 — Map-to-address (reverse geocode)

**Given** the map marker is rendered
**When** the admin drags the marker
**Then** on dragend the page MUST update the form's lat/lng to the new position AND call Nominatim reverse geocode. On success, the address `<input>` MUST update; on failure, the input stays unchanged.

### REQ-LOCATION-5 — Persistence

**Given** the address, lat, or lng has changed
**When** the admin clicks "Guardar cambios" in the Datos form
**Then** the page MUST include `address`, `coordinates: { lat, lng }` in the PUT body.

### REQ-CUSTOMER-1 — Customer card link

**Given** the task has a non-null `customerId`
**When** the page renders
**Then** the Customer card MUST show the customer name (from `customerName`) and a link to `/admin/customers/view/:customerId`.

### REQ-CUSTOMER-2 — Customer empty

**Given** the task has a null `customerId`
**When** the page renders
**Then** the Customer card MUST show an empty state with "Sin cliente asignado" and a "Vincular cliente" button opening a search popover (`GET /api/clients?search=`).

### REQ-SERVICE-1 — Service card

**Given** the task has a non-null `serviceId`
**When** the page renders
**Then** the Service card MUST display the service id as a link to `/admin/customers/view/:customerId#servicios` (deferred direct service detail).

### REQ-REPORTER-1 — Reporter read-only

**Given** the task has a non-null `reporterId`
**When** the page renders
**Then** the Reporter card MUST show the reporter's name (resolved from `useAdmins()` cache) as read-only.

### REQ-DELETE-1 — Delete task

**Given** the kebab menu is open
**When** the admin clicks "Eliminar tarea" and confirms in the dialog
**Then** the page MUST issue `DELETE /api/scheduling/:id`, on success navigate to `/admin/scheduling/projects`, and show a toast "Tarea eliminada".

### REQ-A11Y-1 — Keyboard navigation

All interactive controls (title, stage selector, priority, kebab menu, watcher chips/buttons, form fields, save buttons, map marker) MUST be reachable by Tab in DOM order. Each MUST have a visible focus-visible ring. Skip links are NOT required (single-page detail).

### REQ-A11Y-2 — Screen reader labels

Icon-only buttons (kebab, watcher X, edit pencil) MUST have `aria-label` in Spanish. The save status indicator MUST be an `aria-live="polite"` region.

### REQ-A11Y-3 — Focus management

When the add-watcher popover opens, focus MUST move to its search input. When it closes, focus MUST return to the "Añadir watcher" button. Same pattern for the delete-confirmation dialog (focus on Cancel).

### REQ-A11Y-4 — Reduced motion

If `prefers-reduced-motion: reduce` is set, all transitions (stage pill colour change, chip slide-in, toast slide-up) MUST be 0 ms or use opacity-only fade.

### REQ-A11Y-5 — Contrast

All text MUST meet WCAG AA contrast (4.5:1 for body, 3:1 for large text). Stage category pills explicitly verified per REQ-STAGE-MOVE-2.

### REQ-RESPONSIVE-1 — Breakpoints

- ≥ 1280 px: two-column layout (main 8/12, sidebar 4/12). Sticky header.
- 1024-1279 px: same layout, sidebar narrower (3/12 main 9/12).
- 768-1023 px: single column, sidebar cards stack BELOW main.
- ≤ 767 px: same as 768-1023 but with reduced padding (0.75 rem). Title editor + map both go full-width.

No horizontal scroll at any width ≥ 320 px.

### REQ-LOADING-1 — Initial load

**Given** the page is loading the task
**When** the GET is in flight
**Then** a full-page `<Spinner fullPage />` MUST be shown until first byte. After data arrives, sub-sections MAY show skeleton placeholders for their lookups (workflow, admins, customer) but the page chrome MUST render.

### REQ-LOADING-2 — Saving

**Given** the admin clicks "Guardar" on any section
**When** the mutation is pending
**Then** the button MUST show a spinner and be disabled. Other sections MUST remain interactive.

### REQ-ERROR-1 — Backend error

**Given** any mutation returns a non-2xx response
**When** the response includes a `code` field
**Then** the page MUST display a toast with the Spanish message mapped from the code (e.g., `CUSTOMER_NOT_FOUND` → "Cliente no encontrado"; `VALIDATION_ERROR` → "Datos inválidos: <details>").

### REQ-ERROR-2 — Network error

**Given** a mutation fails with no response (network)
**When** the error surfaces
**Then** the page MUST show a toast "Sin conexión. Reintentar" with a retry button that re-runs the mutation.

### REQ-EMPTY-1 — Watchers empty

**Given** the task has zero watchers
**When** the page renders
**Then** the Watchers section MUST show an empty state "Sin watchers" + the "Añadir watcher" button.

### REQ-EMPTY-2 — Description empty

**Given** the task has empty/null description
**When** the page renders in read-only mode (before focus)
**Then** the editor MUST show a muted placeholder "Sin descripción. Haz clic para añadir."

### REQ-BACKEND-1 — No backend changes

This change MUST NOT modify any file under `C:\Users\ronald\projects\ipnext\ipnext-backend\src\`. All required endpoints already exist.

### REQ-BACKEND-2 — Backend gap discovered during apply

**Given** during apply we discover a missing endpoint (e.g., admin search by `?q=`)
**When** the gap is confirmed
**Then** the change scope MAY expand to add the endpoint following the change 1-3 patterns: TDD red-first, hexagonal port-first, zod `z.string().min(1)`, route composition test, in-memory adapter. Update this spec with a new REQ-BACKEND-N before implementing.
