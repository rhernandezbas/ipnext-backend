# Change Proposal — `scheduling-calendar-view`

## Intent

Replace the placeholder `SchedulingCalendarPage` — currently a hardcoded, non-navigable, single-month grid with no filters and no events — with a fully functional calendar that lets operators visualise and interact with scheduled tasks across Day, Week, and Month views. Day and Week views render a **resource-timeline** (rows = technicians, columns = hours) matching the Splynx reference; Month view shows a navigable event grid with per-day task badges. All views are filter-URL-synced, use the existing design system, and navigate through to the existing Task Detail page.

## Scope IN

### Backend (gap-fill)
- **REQ-FILTER-DATE**: Extend `ListTasksFilterSchema` with optional `from` and `to` ISO datetime params. Apply as `WHERE startDate >= from AND startDate <= to` in `ListTasks` use case. Update `scheduling.routes.ts` to extract and forward these params.
- No schema migration required — `startDate`/`endDate` columns already exist on `ScheduledTask`.

### Frontend (primary)
- Rewrite `SchedulingCalendarPage.tsx` as a structured page (header + toolbar + calendar body) matching `SchedulingProjectsPage` layout conventions.
- Create sibling re-export shim `SchedulingCalendarPage.tsx` if the page moves to a directory (Vite production build lesson 6 from changes 1-6).
- New sub-components: `CalendarToolbar`, `CalendarMonthView`, `CalendarWeekView`, `CalendarDayView`.
- New hooks: `useTasksForCalendar(filter, from, to)`, `useCalendarUrlState()`.
- New CSS module: `SchedulingCalendarPage.module.css` using only design-system tokens from `SchedulingProjectsPage.module.css`.
- Vitest tests: render, navigate, filter, click event, URL sync.

## Scope OUT (deferred)

- Drag-and-drop event resize/move across resources (needs dnd-kit integration with time-grid)
- Multi-day event spanning
- Recurring events
- Backlog panel (Splynx has a "Backlog" button)
- Custom event colours per project
- Calendar exports (ics/csv)
- Mobile viewport (< 768px) — degrades gracefully but not polished

## Capabilities Modified / Added

| Capability | Layer | Delta |
|------------|-------|-------|
| `scheduling` — task list filter | Backend | ADD `from`/`to` ISO datetime params to `ListTasksFilterSchema` + route extraction |
| `scheduling-calendar` | Frontend | NEW page, components, hooks replacing the placeholder |

## Approach

1. **Backend first**: extend `ListTasksFilterSchema` with `from`/`to` (5 lines of Zod). Update `ListTasks.execute` to apply `startDate: { gte: from, lte: to }` Prisma filter. Update route handler to extract `from`/`to` from `req.query` and pass through `buildFilterParams`. Add backend unit test for the date filter.
2. **Install nothing if Option D (Custom CSS Grid) is chosen** — see design.md AD-1. If Option C (schedule-x) is chosen, install `@schedule-x/react @schedule-x/calendar @schedule-x/theme-default`.
3. **New hooks**: `useCalendarUrlState` reads/writes `?view=&date=&projectId=&stageIds[]=&partnerId=&assigneeId=` from URL. `useTasksForCalendar` wraps `useFilteredTasks` with computed `from`/`to` derived from current view + date.
4. **CalendarToolbar**: project dropdown + stage/partner filters + view selector (Día/Semana/Mes) + prev/today/next navigation. Matches `SchedulingProjectsPage` header button styles.
5. **CalendarMonthView**: CSS Grid 7-col, navigable. Per-cell: date number + up to 3 task pills + "+N más". Click empty cell → create modal pre-filled with date.
6. **CalendarDayView / CalendarWeekView**: resource-timeline built with CSS Grid. Sidebar = technician rows grouped by `Admin.role`. Main grid = hours (Day: 24 columns or 08–20 business hours; Week: 7 day columns × hour rows). Events rendered as absolutely-positioned pills spanning start→end hours.
7. **Page assembly**: rewrite `SchedulingCalendarPage.tsx` following exact `SchedulingProjectsPage` header pattern (breadcrumb `Scheduling /`, h1 `Calendario`, `btnPrimary` for "Añadir tarea", `btnSecondary` for "Filtrar").
8. **Tests + smoke E2E**: Vitest for unit/integration; Playwright smoke plan in `tasks.md`.

## Affected Areas

### Backend
- `src/application/dto/scheduling.dto.ts` — extend `ListTasksFilterSchema`
- `src/application/use-cases/ListTasks.ts` — apply date range filter
- `src/infrastructure/http/routes/scheduling.routes.ts` — extract `from`/`to` from query
- `src/__tests__/application/ListTasks.test.ts` — add date filter test cases

### Frontend
- `src/pages/scheduling/SchedulingCalendarPage.tsx` — full rewrite (+ sibling shim if moved to dir)
- `src/pages/scheduling/SchedulingCalendarPage.module.css` — full rewrite
- `src/pages/scheduling/SchedulingCalendarPage/` — new directory with sub-components
- `src/hooks/useScheduling.ts` — no change (re-uses `useFilteredTasks`)
- `src/api/scheduling.api.ts` — extend `buildFilterParams` to include `from`/`to`
- `src/types/scheduling.ts` — extend `TaskListFilter` with `from?`/`to?`
- `src/__tests__/scheduling/` — new test file for calendar page

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|-----------|
| CSS Grid resource-timeline performance with 40+ technicians | Medium | Virtualise rows or cap visible rows with scroll; lazy render off-screen rows |
| `from`/`to` backend filter returns too many tasks for a week view (100+ tasks) | Low | Add `limit` guard or paginate; calendar only needs tasks in the current window |
| Vite empty chunk (Lesson 6) if page moves to a directory | High (known) | MUST create sibling `.tsx` re-export shim as done for `SchedulingTasksPage` |
| Date-fns not installed — need to verify | Medium | Native `Intl.DateTimeFormat` + `Date` arithmetic as fallback; no moment |

## Frontend Coordination

The route `/admin/scheduling/calendars` is already registered in `App.tsx` pointing to `SchedulingCalendarPage`. Any consumer of that route (nav link) will automatically get the new implementation. No other page currently imports `SchedulingCalendarPage` directly.

## Rollback Plan

The old placeholder is fully replaced. Rollback = `git revert` the frontend commit. Backend date-filter addition is additive and non-breaking (optional params with undefined defaulting to no filter).

## Dependencies

- Changes 1-6 deployed (ScheduledTask has `startDate`/`endDate`, `assigneeId`, `stageId` FK, `stage.category`).
- `useTechnicians()` hook already exists in `useAdmins.ts` (`useAdmins({ role: 'technician' })`).
- dnd-kit is already installed (change 5) — available for future drag-drop iteration.

## Success Criteria

1. Navigating to `/admin/scheduling/calendars` renders a page visually consistent with `SchedulingProjectsPage` (same breadcrumb style, same button colours, same card border).
2. Switching between Día / Semana / Mes updates the view and syncs `?view=` to the URL.
3. Clicking prev/next/Today updates `?date=` in the URL and re-fetches tasks with correct `from`/`to`.
4. Day view shows a resource-timeline with technician rows grouped by role.
5. Clicking a task pill navigates to `/admin/scheduling/tasks/:id`.
6. Clicking an empty slot opens a create-task modal pre-filled with date/time + technician.
7. Filter dropdowns (project, stage, partner) URL-sync and re-fetch tasks.
8. `tsc --noEmit` passes on both backend and frontend after all changes.
9. `npm test` passes on both projects with no regressions.
10. Smoke E2E (10 Playwright steps) passes against the running app.
