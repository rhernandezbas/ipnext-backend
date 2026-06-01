# Spec — `scheduling-calendar` capability

**Change**: `scheduling-calendar-view`
**Status**: Draft
**RFC 2119 keywords**: MUST, MUST NOT, SHOULD, MAY

---

## REQ-FILTER-DATE — Backend date range filter

### Context
`GET /api/scheduling` currently accepts `projectId`, `stageIds[]`, `partnerId`, `assigneeId`, `q`. The calendar page needs to fetch only tasks within a specific date window (day/week/month) to avoid loading the entire task list.

### Requirements

**REQ-FILTER-DATE-1**: The API `GET /api/scheduling` MUST accept optional query parameters `from` and `to`, each an ISO 8601 datetime string.

**REQ-FILTER-DATE-2**: When `from` is provided, the response MUST include only tasks where `startDate >= from`.

**REQ-FILTER-DATE-3**: When `to` is provided, the response MUST include only tasks where `startDate <= to`.

**REQ-FILTER-DATE-4**: When neither `from` nor `to` is provided, the behaviour MUST be identical to the current API (no date filtering).

**REQ-FILTER-DATE-5**: When `from` or `to` is not a valid ISO 8601 datetime string, the API MUST return `400 VALIDATION_ERROR`.

**REQ-FILTER-DATE-6**: `from` and `to` MUST be optional individually; providing only one is valid.

### Scenarios

```gherkin
Given the API has tasks with startDate 2026-05-19, 2026-05-20, 2026-05-21
When GET /api/scheduling?from=2026-05-20T00:00:00Z&to=2026-05-20T23:59:59Z
Then the response includes only the task with startDate 2026-05-20
And the HTTP status is 200

Given the API has tasks with startDate 2026-05-19
When GET /api/scheduling?from=2026-05-20T00:00:00Z
Then the response is an empty array
And the HTTP status is 200

When GET /api/scheduling?from=not-a-date
Then the HTTP status is 400
And the body contains code "VALIDATION_ERROR"
```

---

## REQ-PAGE — Page structure and consistency

**REQ-PAGE-1**: The route `/admin/scheduling/calendars` MUST render `SchedulingCalendarPage`.

**REQ-PAGE-2**: The page MUST render a header with:
- A breadcrumb element reading `Scheduling /` styled with `var(--color-accent)` (matching `SchedulingProjectsPage`).
- An `<h1>` reading `Calendario`.
- A primary button "Añadir tarea" using `var(--color-accent)` background (NOT a custom blue).
- A secondary button "Filtrar" that toggles the filter panel.

**REQ-PAGE-3**: The page MUST NOT introduce any colour or spacing tokens not already present in `SchedulingProjectsPage.module.css`. New CSS variables are forbidden.

**REQ-PAGE-4**: The page MUST be wrapped in a re-export shim `SchedulingCalendarPage.tsx` if the component is moved to a directory, following the `SchedulingTasksPage.tsx` pattern. This is MANDATORY to avoid Vite production build empty-chunk regression.

### Scenario

```gherkin
Given the user navigates to /admin/scheduling/calendars
When the page renders
Then a breadcrumb "Scheduling /" is visible
And an h1 "Calendario" is visible
And a button "Añadir tarea" has background color var(--color-accent)
```

---

## REQ-VIEW-MONTH — Month grid view

**REQ-VIEW-MONTH-1**: When `?view=month` (or `view` is absent and defaults to `week`), activating the "Mes" tab MUST render a 7-column date grid for the current month.

**REQ-VIEW-MONTH-2**: Each day cell MUST display the day number.

**REQ-VIEW-MONTH-3**: Cells MUST show at most 3 task pills. If more tasks exist on that day, a "+N más" link MUST be rendered below the pills, where N is the count of hidden tasks.

**REQ-VIEW-MONTH-4**: Each task pill MUST show the task title truncated to one line.

**REQ-VIEW-MONTH-5**: The current day cell MUST be visually distinguished (e.g., accent-coloured day number).

**REQ-VIEW-MONTH-6**: Days from the previous/next month that fill the grid MUST be rendered in a muted style.

**REQ-VIEW-MONTH-7**: When there are no tasks in the visible range, the page MUST show an empty-state message: "Sin tareas en este rango. Cargá una nueva o ajustá los filtros."

### Scenarios

```gherkin
Given the current month has tasks on May 20 (3 tasks) and May 21 (5 tasks)
When the user is in Month view
Then May 20 shows 3 task pills
And May 21 shows 3 task pills and a "+2 más" link

Given the visible month has no tasks
When the Month view renders
Then the empty-state message "Sin tareas en este rango." is visible
```

---

## REQ-VIEW-WEEK — Week view

**REQ-VIEW-WEEK-1**: The "Semana" tab MUST render a resource-timeline with technicians as rows (grouped by `Admin.role`) and 7 day columns.

**REQ-VIEW-WEEK-2**: Each row header MUST show the technician's initials avatar and name.

**REQ-VIEW-WEEK-3**: Group headers (role names) MUST be rendered as collapsible section headers above the technician rows.

**REQ-VIEW-WEEK-4**: Tasks assigned to a technician MUST appear as pills in that technician's row in the correct day column.

**REQ-VIEW-WEEK-5**: Tasks with no assignee MUST appear in an "Sin asignar" row at the bottom.

**REQ-VIEW-WEEK-6**: The grid MUST be horizontally scrollable if columns overflow the viewport.

### Scenario

```gherkin
Given technician "Ronald Hernandez" has role "technician" and task T1 on Monday of the current week
When the user is in Week view
Then "Ronald Hernandez" appears as a row under the "technician" group
And task T1 appears in Monday's column of that row
```

---

## REQ-VIEW-DAY — Day resource-timeline view

**REQ-VIEW-DAY-1**: The "Día" tab MUST render a resource-timeline with technicians as rows and hours (00:00–23:59) as columns.

**REQ-VIEW-DAY-2**: Default visible hours MUST be 08:00–20:00. A "Full day" toggle MUST show 00:00–23:59.

**REQ-VIEW-DAY-3**: Each technician row MUST have a fixed-width sidebar (240px at 1280px viewport) showing initials avatar + name.

**REQ-VIEW-DAY-4**: Task pills MUST be positioned to span the correct start–end hour slots. Minimum pill width = 1 hour slot.

**REQ-VIEW-DAY-5**: Tasks with no assignee MUST appear in an "Sin asignar" row.

**REQ-VIEW-DAY-6**: The sidebar MUST scroll vertically with the row area (sticky header; sticky sidebar column).

**REQ-VIEW-DAY-7**: The hour header row MUST be sticky at the top of the time grid.

### Scenario

```gherkin
Given task T1 has assigneeId=admin-1 (role technician), startDate=2026-05-20T09:00:00Z, endDate=2026-05-20T11:00:00Z
When the user is in Day view for 2026-05-20
Then admin-1's row shows a pill spanning 09:00–11:00
And the pill is 2 hour-columns wide
```

---

## REQ-NAV — Navigation

**REQ-NAV-1**: The toolbar MUST contain "‹" (prev), "Today", "›" (next) buttons.

**REQ-NAV-2**: Clicking prev/next MUST move the date by ±1 day (Day view), ±1 week (Week view), or ±1 month (Month view).

**REQ-NAV-3**: Clicking "Today" MUST reset the date to the current day.

**REQ-NAV-4**: Each navigation action MUST update the `?date=YYYY-MM-DD` URL param using `replace: true` (no history stack pollution).

**REQ-NAV-5**: The toolbar MUST display the current period label (e.g., "miércoles, 20 mayo 2026" for Day; "20 may – 26 may 2026" for Week; "Mayo 2026" for Month).

### Scenario

```gherkin
Given the user is in Week view with ?date=2026-05-20
When the user clicks "›"
Then the URL becomes ?date=2026-05-27
And the week grid advances to 27 may – 2 jun 2026
```

---

## REQ-CLICK-EVENT — Click a task

**REQ-CLICK-EVENT-1**: Clicking a task pill in any view MUST navigate to `/admin/scheduling/tasks/:id`.

**REQ-CLICK-EVENT-2**: The navigation MUST use React Router `navigate()` (client-side, no full page reload).

### Scenario

```gherkin
Given task T1 is visible as a pill in Day view
When the user clicks T1's pill
Then the browser navigates to /admin/scheduling/tasks/{T1.id}
```

---

## REQ-CLICK-EMPTY — Click an empty slot

**REQ-CLICK-EMPTY-1**: Clicking an empty hour slot in Day or Week view MUST open the create-task modal.

**REQ-CLICK-EMPTY-2**: The modal MUST be pre-filled with the clicked date + hour as `startDate`.

**REQ-CLICK-EMPTY-3**: If the clicked slot is in a technician row, the modal MUST pre-fill `assigneeId` with that technician's id.

**REQ-CLICK-EMPTY-4**: Clicking an empty day cell in Month view MUST open the create-task modal pre-filled with that day's date (time = 08:00 default).

### Scenario

```gherkin
Given the user is in Day view for 2026-05-20
When the user clicks the 10:00 slot in "Ronald Hernandez"'s row
Then the create-task modal opens
And startDate is pre-filled with 2026-05-20T10:00:00
And assigneeId is pre-filled with Ronald Hernandez's admin id
```

---

## REQ-URL-SYNC — URL state synchronisation

**REQ-URL-SYNC-1**: The URL MUST reflect the full calendar state: `?view=day|week|month&date=YYYY-MM-DD&projectId=&stageIds[]=&partnerId=&assigneeId=`.

**REQ-URL-SYNC-2**: Default `view` = `week`. Default `date` = today (ISO date).

**REQ-URL-SYNC-3**: Changing any filter MUST update the URL using `replace: true` (no history entry).

**REQ-URL-SYNC-4**: On page load, the URL params MUST be the authoritative source of state (no local useState for filter/view/date).

**REQ-URL-SYNC-5**: Copying the URL and opening it in a new tab MUST reproduce the same view/date/filter state.

### Scenario

```gherkin
Given the user is at /admin/scheduling/calendars?view=day&date=2026-05-20&projectId=proj-1
When the user copies the URL and opens a new tab
Then the new tab renders Day view for 2026-05-20 filtered by proj-1
```

---

## REQ-A11Y — Accessibility

**REQ-A11Y-1**: Each task pill MUST have an `aria-label` describing the task: "Tarea: {title}, {startDate formatted}".

**REQ-A11Y-2**: Task pills MUST be keyboard-focusable (`tabIndex={0}`) and MUST respond to Enter/Space as a click.

**REQ-A11Y-3**: The scheduler region MUST have `role="region"` and `aria-label="Calendario de tareas"`.

**REQ-A11Y-4**: Navigation buttons MUST have descriptive `aria-label` attributes ("Semana anterior", "Semana siguiente", "Hoy").

**REQ-A11Y-5**: Group headers (role names) in the resource-timeline MUST be rendered as `<th scope="rowgroup">` or equivalent ARIA landmark.

---

## REQ-RESPONSIVE — Responsive behaviour

**REQ-RESPONSIVE-1**: At 1280px viewport, the full resource-timeline MUST render without horizontal scroll on the sidebar; the hour grid MUST scroll horizontally.

**REQ-RESPONSIVE-2**: At 768px viewport, the resource sidebar MUST collapse to a dropdown selector (current technician shown, click to switch).

**REQ-RESPONSIVE-3**: At 768px viewport, Month view MUST be fully usable (cells may be smaller but date numbers and pill counts must be readable).

**REQ-RESPONSIVE-4**: Below 480px, the page MUST NOT crash; it MAY degrade to a simplified list representation.
