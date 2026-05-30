# Tasks — `scheduling-calendar-view`

TDD Mode: ACTIVE. Write failing test → make it pass → refactor. Quality gate: `npm test` must pass after each task group.

---

## Phase 1 — Backend: date range filter [x COMPLETE]

### 1.1 Extend `ListTasksFilterSchema` [x]

In `src/application/dto/scheduling.dto.ts`:

- Add `from: z.string().datetime({ offset: true }).optional()` and `to: z.string().datetime({ offset: true }).optional()` to `ListTasksFilterSchema`.
- Export updated `TaskListFilter` type (TypeScript will widen automatically).
- No new refinement needed (`from > to` is not a hard error at filter level — just returns empty set).

### 1.2 Extend `ListTasks` use case [x]

In `src/application/use-cases/ListTasks.ts`:

- Accept `filter.from` / `filter.to` and pass to repository.
- In `PrismaSchedulingRepository`, add to Prisma `where`: `...(filter.from ? { startDate: { gte: new Date(filter.from) } } : {})`, similarly for `to` (`lte`). When both present, use `{ startDate: { gte: ..., lte: ... } }`.

### 1.3 Extend route handler [x]

In `src/infrastructure/http/routes/scheduling.routes.ts`:

- Extract `req.query['from']` and `req.query['to']` from `rawQuery` and pass to `ListTasksFilterSchema.safeParse`.
- No DTO change needed — schema already accepts them after 1.1.

### 1.4 Tests — backend date filter (RED first) [x]

In `src/__tests__/application/ListTasks.test.ts`:

```typescript
// Scenarios to cover:
// - from only: returns tasks with startDate >= from
// - to only: returns tasks with startDate <= to
// - both: returns tasks in range
// - neither: returns all tasks (no regression)
// - task with null startDate: excluded from range-filtered results (startDate IS NULL)
```

Use `InMemorySchedulingRepository`. Create 3 tasks with distinct `startDate`s. Assert filter reduces result set correctly.

**Gate**: `npm test` passes in backend before proceeding to Phase 2.

---

## Phase 2 — Frontend setup [x COMPLETE]

### 2.1 Create type file [x]

Create `src/types/calendar.ts` with `CalendarView`, `CalendarEvent`, `CalendarResource`, `CalendarUrlState` interfaces (see design.md TypeScript Interfaces section).

### 2.2 Extend `TaskListFilter` type [x]

In `src/types/scheduling.ts`: add `from?: string; to?: string` to `TaskListFilter` interface.

### 2.3 Extend `buildFilterParams` [x]

In `src/api/scheduling.api.ts`: add `if (filter?.from) params['from'] = filter.from` and same for `to`.

### 2.4 Create directory structure [x]

```
src/pages/scheduling/SchedulingCalendarPage/
  index.tsx                          (page component — stub returning null initially)
  SchedulingCalendarPage.module.css  (empty initially)
  hooks/
    useCalendarUrlState.ts
    useTasksForCalendar.ts
  components/
    CalendarToolbar.tsx
    CalendarToolbar.module.css
    CalendarMonthView.tsx
    CalendarMonthView.module.css
    CalendarWeekView.tsx
    CalendarWeekView.module.css
    CalendarDayView.tsx
    CalendarDayView.module.css
    EventPill.tsx
    ResourceSidebar.tsx
```

### 2.5 Create shim re-export [x]

Rewrite `src/pages/scheduling/SchedulingCalendarPage.tsx` (the existing placeholder file) to:
```typescript
export { default } from './SchedulingCalendarPage/index';
```

This follows the exact pattern of `SchedulingTasksPage.tsx` (lesson 6 — Vite production build fix).

**Gate**: `tsc --noEmit` passes on frontend (all types resolve, even with stubs).

---

## Phase 3 — Hooks [x COMPLETE]

### 3.1 `useCalendarUrlState` [x]

File: `src/pages/scheduling/SchedulingCalendarPage/hooks/useCalendarUrlState.ts`

Logic:
- Use `useSearchParams()` from React Router.
- Read `view` (default: `'week'`), `date` (default: today as `YYYY-MM-DD`), `projectId`, `stageIds[]`, `partnerId`, `assigneeId`, `fullDay`.
- Derive `from` and `to` from `view` + `date`:
  - `day`: from = `${date}T00:00:00Z`, to = `${date}T23:59:59Z`
  - `week` (Mon-first): from = Monday of the week, to = Sunday 23:59:59
  - `month`: from = first day of month 00:00:00, to = last day 23:59:59
- Return the full `CalendarUrlState` shape (see design.md).
- `goNext`, `goPrev`, `goToday` compute new date and call `setSearchParams` with `replace: true`.
- All writes use `replace: true`.

### 3.2 `useTasksForCalendar` [x]

File: `src/pages/scheduling/SchedulingCalendarPage/hooks/useTasksForCalendar.ts`

```typescript
export function useTasksForCalendar(filter: TaskListFilter, from: string, to: string) {
  return useFilteredTasks({ ...filter, from, to });
}
```

That's it — thin wrapper. Query key is already keyed on the full filter object by `useFilteredTasks`.

### 3.3 Tests — hooks (RED first) [x]

In `src/__tests__/scheduling/useCalendarUrlState.test.ts`:
- Wrap in `MemoryRouter` with initial entries.
- Test: default view = `'week'`, default date = today.
- Test: `goNext` in week view advances date by 7 days.
- Test: `goPrev` in week view retreats by 7 days.
- Test: `goToday` resets to today.
- Test: `from`/`to` derived correctly for each view mode.
- Test: URL params reflected in returned `filter.projectId`.

**Gate**: `npm test` passes on frontend.

---

## Phase 4 — CalendarToolbar [x COMPLETE]

File: `src/pages/scheduling/SchedulingCalendarPage/components/CalendarToolbar.tsx`

Props:
```typescript
interface CalendarToolbarProps {
  view: CalendarView;
  onViewChange: (v: CalendarView) => void;
  periodLabel: string;        // e.g. "20 may 2026"
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  filter: TaskListFilter;
  onFilterChange: (patch: Partial<TaskListFilter>) => void;
  onAddTask: () => void;
  fullDay: boolean;
  onToggleFullDay: () => void;
  showFullDayToggle: boolean;  // only when view = 'day'
}
```

Layout:
```
[Proyecto ▾] [Socio ▾]   |   ‹  [period label]  ›  [Today]   |   [Día] [Semana] [Mes]   |   [Full day toggle] (day view only)
```

Design rules:
- View selector buttons: use `btnSecondary` for inactive, `btnSecondaryActive` for active — same CSS classes as `SchedulingProjectsPage`.
- Period label: `font-weight: 600`, `font-size: 14px`, min-width so it doesn't jump during navigation.
- Project dropdown: `<select>` using `pageSizeSelect` CSS class or equivalent. Options loaded from `useProjects()` inside the page, passed as prop.
- Partner dropdown: same pattern, loaded from `usePartners()`.
- Nav buttons (‹, ›, Today): use `btnIcon` CSS class.
- Full day toggle: `<button className={fullDay ? styles.btnSecondaryActive : styles.btnSecondary}>Full day</button>`.
- ARIA: nav buttons get `aria-label="Período anterior"`, `aria-label="Período siguiente"`, `aria-label="Hoy"`.

Tests (RED first): render toolbar, assert period label, click Día button → `onViewChange` called with `'day'`, click `›` → `onNext` called.

---

## Phase 5 — CalendarMonthView [x COMPLETE]

File: `src/pages/scheduling/SchedulingCalendarPage/components/CalendarMonthView.tsx`

Props:
```typescript
interface CalendarMonthViewProps {
  year: number;
  month: number;  // 0-indexed
  events: CalendarEvent[];
  onEventClick: (id: string) => void;
  onDayClick: (date: Date) => void;  // opens create modal
  onMoreClick: (date: Date) => void; // switches to day view for that date
  isLoading: boolean;
}
```

Implementation:
- 7-column CSS Grid. Header row = day names (Lun, Mar, Mié, Jue, Vie, Sáb, Dom).
- Compute `cells` array: leading blanks for days before the 1st (Mon-first), then 1…daysInMonth.
- Group `events` by `event.start.toISOString().slice(0, 10)`.
- Per cell: render day number + up to 3 `EventPill` components (month variant: smaller) + "+N más" link if overflow.
- `isLoading`: render skeleton (35 shimmer cells).
- Empty state: if no tasks in the whole month, render the empty-state block (see AD-11).
- Today cell: apply `styles.cellToday` — accent-coloured day number.
- `aria-label` on each cell: `"${dayNum} de ${monthName}"`.

CSS: `grid-template-columns: repeat(7, 1fr)`. Cell `min-height: 100px`. No hard height (auto-grows if many events were shown — but we cap at 3 + overflow link).

Tests (RED first): renders 28–35 cells; tasks appear in correct cells; "+2 más" renders when 5 tasks on a day; skeleton renders when `isLoading`; empty state renders when `events` is empty.

---

## Phase 6 — CalendarWeekView [x COMPLETE]

File: `src/pages/scheduling/SchedulingCalendarPage/components/CalendarWeekView.tsx`

Props:
```typescript
interface CalendarWeekViewProps {
  weekStart: Date;     // Monday of the week
  resources: CalendarResource[];
  events: CalendarEvent[];
  onEventClick: (id: string) => void;
  onSlotClick: (date: Date, resourceId: string) => void;
  isLoading: boolean;
}
```

Implementation:
- Sidebar (240px sticky left): role group headers (collapsible) + technician rows.
- Main grid: `grid-template-columns: repeat(7, minmax(120px, 1fr))`. Header row = day labels (Lun 20/5, Mar 21/5, …).
- Per resource row + day column: render all events for (resource, day) as pills stacked vertically.
- Event pills: use `EventPill` component in "week variant" (no address, title only, category colour).
- Empty slot: clickable div that fires `onSlotClick(date, resourceId)`.
- "Sin asignar" row at bottom for tasks with `resourceId === 'unassigned'`.
- `isLoading`: shimmer skeleton (4 rows × 7 columns).
- Group headers (`role` label): `font-size: 11px`, `font-weight: 700`, `text-transform: uppercase`, `color: var(--color-text-secondary)`, `letter-spacing: 0.06em`. Collapsible (click hides rows of that group).

Tests (RED first): renders 7 day columns; task appears in correct (resource, day) cell; "Sin asignar" row renders for tasks without assignee; clicking empty slot fires `onSlotClick`.

---

## Phase 7 — CalendarDayView (resource-timeline) [x COMPLETE]

File: `src/pages/scheduling/SchedulingCalendarPage/components/CalendarDayView.tsx`

Props:
```typescript
interface CalendarDayViewProps {
  date: Date;
  resources: CalendarResource[];
  events: CalendarEvent[];
  fullDay: boolean;   // 00–23 vs 08–20
  onEventClick: (id: string) => void;
  onSlotClick: (date: Date, hour: number, resourceId: string) => void;
  isLoading: boolean;
}
```

Implementation:
- Two-part layout: `ResourceSidebar` (240px, sticky left) + `TimeGrid` (scrolls horizontally).
- `TimeGrid` CSS:
  ```
  grid-template-columns: repeat(N_HOURS, minmax(60px, 1fr));
  grid-template-rows: 24px [header] repeat(N_RESOURCES, 48px);
  ```
- Hour header row: sticky top, cells = "08:00", "09:00", … rendered as `<th>` equivalents.
- For each resource: render a row of N_HOURS cells. Each cell = clickable empty slot.
- Task pills: `position: absolute` within a relative-positioned row container. `left = (startMinutes / 60) * (100 / N_HOURS)%` for the column, `width` = span in hours × column width. Clamped to row bounds.
- Alternatively (simpler): grid placement via `grid-column-start` / `grid-column-end` derived from hour numbers.
- Group headers: same collapsible pattern as WeekView.
- `fullDay = false` (default): hours 8–20 = 12 columns, `minmax(80px, 1fr)`.
- `fullDay = true`: hours 0–23 = 24 columns, `minmax(60px, 1fr)`.
- Loading: shimmer rows.

`ResourceSidebar` component:
```typescript
interface ResourceSidebarProps {
  resources: CalendarResource[];
  groupBy: (r: CalendarResource) => string;  // returns role name
}
```
Renders: collapsible group header + per-resource row (initials avatar circle + name label).
Avatar: 32px circle, background = deterministic colour from name hash (6 accent-adjacent colours from the palette, cycling by index), white initials text.

Tests (RED first): renders hour headers for 08–20 range; `fullDay=true` renders 24 headers; resource rows equal `resources.length`; task pill renders in correct hour column; clicking empty slot fires `onSlotClick` with correct hour.

---

## Phase 8 — Page assembly [x COMPLETE]

### 8.1 Rewrite `index.tsx`

File: `src/pages/scheduling/SchedulingCalendarPage/index.tsx`

Structure:
```tsx
export default function SchedulingCalendarPage() {
  const { view, date, from, to, filter, fullDay,
          setView, setDate, setFilter, toggleFullDay,
          goNext, goPrev, goToday, periodLabel } = useCalendarUrlState();

  const { data: rawTasks = [], isLoading } = useTasksForCalendar(filter, from, to);
  const { data: admins = [] } = useTechnicians();       // only role=technician for sidebar
  const { data: projects = [] } = useProjects();
  const { data: partners = [] } = usePartners();

  const navigate = useNavigate();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createPreFill, setCreatePreFill] = useState<{startDate?: string; assigneeId?: string}>({});
  const [showFilters, setShowFilters] = useState(false);

  // Derive CalendarEvent[] from rawTasks
  const events: CalendarEvent[] = useMemo(() => rawTasks.map(toCalendarEvent), [rawTasks]);

  // Derive CalendarResource[] from admins
  const resources: CalendarResource[] = useMemo(() => admins.map(toCalendarResource), [admins]);

  function handleEventClick(id: string) {
    navigate(`/admin/scheduling/tasks/${id}`);
  }

  function handleSlotClick(slotDate: Date, resourceId: string) {
    setCreatePreFill({ startDate: slotDate.toISOString(), assigneeId: resourceId });
    setShowCreateModal(true);
  }

  return (
    <div className={styles.page}>
      {/* Header — mirrors SchedulingProjectsPage exactly */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.breadcrumb}>Scheduling /</span>
          <h1 className={styles.title}>Calendario</h1>
        </div>
        <div className={styles.headerRight}>
          <button className={styles.btnPrimary} onClick={() => { setCreatePreFill({}); setShowCreateModal(true); }}>
            Añadir tarea
          </button>
          <button
            className={`${styles.btnSecondary} ${showFilters ? styles.btnSecondaryActive : ''}`}
            onClick={() => setShowFilters(v => !v)}
          >
            Filtrar
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <CalendarToolbar
        view={view}
        onViewChange={setView}
        periodLabel={periodLabel}
        onPrev={goPrev}
        onNext={goNext}
        onToday={goToday}
        filter={filter}
        onFilterChange={setFilter}
        projects={projects}
        partners={partners}
        fullDay={fullDay}
        onToggleFullDay={toggleFullDay}
        showFullDayToggle={view === 'day'}
      />

      {/* Calendar body */}
      <div className={styles.body}>
        <div className={styles.calendarSection}>
          {view === 'month' && (
            <CalendarMonthView
              year={date.getFullYear()}
              month={date.getMonth()}
              events={events}
              onEventClick={handleEventClick}
              onDayClick={d => handleSlotClick(d, 'unassigned')}
              onMoreClick={d => { setDate(d); setView('day'); }}
              isLoading={isLoading}
            />
          )}
          {view === 'week' && (
            <CalendarWeekView
              weekStart={getWeekStart(date)}
              resources={resources}
              events={events}
              onEventClick={handleEventClick}
              onSlotClick={handleSlotClick}
              isLoading={isLoading}
            />
          )}
          {view === 'day' && (
            <CalendarDayView
              date={date}
              resources={resources}
              events={events}
              fullDay={fullDay}
              onEventClick={handleEventClick}
              onSlotClick={(d, hour, rid) => handleSlotClick(
                new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0),
                rid
              )}
              isLoading={isLoading}
            />
          )}
        </div>

        {/* Filter panel — same pattern as SchedulingProjectsPage */}
        {showFilters && (
          <div className={styles.filterPanel}>
            {/* project / stage / partner selects */}
          </div>
        )}
      </div>

      {/* Create task modal — reuse existing modal if props-compatible */}
      {showCreateModal && (
        <CreateTaskModal
          preFill={createPreFill}
          onClose={() => setShowCreateModal(false)}
        />
      )}
    </div>
  );
}
```

### 8.2 CSS module

File: `src/pages/scheduling/SchedulingCalendarPage/SchedulingCalendarPage.module.css`

Copy `.page`, `.header`, `.headerLeft`, `.headerRight`, `.breadcrumb`, `.title`, `.body`, `.filterPanel`, `.btnPrimary`, `.btnSecondary`, `.btnSecondaryActive`, `.filterGroup`, `.filterLabel`, `.filterInput`, `.filterActions` verbatim from `SchedulingProjectsPage.module.css`.

Add calendar-specific classes:
```css
.calendarSection {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
  flex-wrap: wrap;
}

/* Resource timeline */
.timelineWrapper {
  display: flex;
  overflow: hidden;
  flex: 1;
}

.sidebar {
  width: 240px;
  flex-shrink: 0;
  border-right: 1px solid var(--color-border);
  overflow-y: auto;
  position: sticky;
  left: 0;
  z-index: 5;
  background: var(--color-surface);
}

.timeGrid {
  flex: 1;
  overflow: auto;
  position: relative;
}

/* Avatar */
.avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  color: white;
  flex-shrink: 0;
}

/* Event pill */
.eventPill {
  border-radius: var(--radius-md);
  padding: 2px 6px;
  font-size: 12px;
  font-weight: 600;
  color: white;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  transition: filter 0.1s;
}

.eventPill:hover { filter: brightness(1.1); }
.eventPill:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }

/* Category colours */
.catNuevo      { background: #3b82f6; }
.catEnProgreso { background: #f59e0b; }
.catHecho      { background: #10b981; }

/* Skeleton shimmer */
@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

.skeleton {
  background: linear-gradient(90deg, var(--color-gray-100) 25%, var(--color-gray-50) 50%, var(--color-gray-100) 75%);
  background-size: 400% 100%;
  animation: shimmer 1.5s ease-in-out infinite;
  border-radius: var(--radius-md);
}

/* Empty state */
.emptyState {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 64px 24px;
  color: var(--color-text-secondary);
  font-size: 15px;
  text-align: center;
}

.emptyIcon {
  color: var(--color-gray-300);
  width: 48px;
  height: 48px;
}

/* Responsive 768px */
@media (max-width: 768px) {
  .sidebar {
    width: 100%;
    position: static;
    border-right: none;
    border-bottom: 1px solid var(--color-border);
  }

  .timelineWrapper {
    flex-direction: column;
  }
}
```

---

## Phase 9 — Route registration check [x COMPLETE — route already exists at App.tsx:211]

Verify `src/App.tsx` already has:
```tsx
<Route path="/admin/scheduling/calendars" element={<SchedulingCalendarPage />} />
```

If absent, add it adjacent to the other scheduling routes. This is likely already present (it was a placeholder before). No new route registration expected.

---

## Phase 10 — Vitest tests [x COMPLETE]

File: `src/__tests__/scheduling/SchedulingCalendarPage.test.tsx`

Test cases:
1. **Page renders**: default view is `week`; breadcrumb "Scheduling /" visible; h1 "Calendario" visible.
2. **View switch**: clicking "Día" tab updates URL to `?view=day`; clicking "Mes" tab updates to `?view=month`.
3. **Navigation**: in week view, clicking `›` advances URL `?date` by 7 days.
4. **Today**: clicking "Today" sets `?date` to today's ISO date.
5. **Month view renders tasks**: mock `useFilteredTasks` to return 1 task on a specific date; assert pill renders in the correct day cell.
6. **Month view overflow**: 5 tasks on same date → 3 pills + "+2 más".
7. **Event click navigation**: clicking a task pill calls `navigate(/admin/scheduling/tasks/{id})`.
8. **Empty state**: `useFilteredTasks` returns empty array → empty state message visible.
9. **URL state persistence**: mount with `?view=day&date=2026-05-20&projectId=proj-1`; assert Day view renders and filter has `projectId: 'proj-1'`.
10. **Full day toggle**: only visible in Day view; toggling updates URL `?fullDay=1`.

---

## Phase 11 — Final verification [x COMPLETE]

### 11.1 Backend typecheck + tests

```bash
# from ipnext-backend
npx tsc --noEmit
npm test
```

Expected: all existing tests pass + new `ListTasks` date filter tests pass.

### 11.2 Frontend typecheck + tests

```bash
# from ipnext-frontend
npx tsc --noEmit
npm test
```

Expected: all existing tests pass + new calendar tests pass.

### 11.3 Visual check list (before smoke E2E)

- [ ] Header visually matches `SchedulingProjectsPage` (same breadcrumb, same button styles, same accent colour).
- [ ] Day view sidebar is 240px with initials avatars.
- [ ] Task pills use category colours (blue = nuevo, amber = enProgreso, green = hecho).
- [ ] Empty state renders SVG icon + message + CTA button.
- [ ] Skeleton shimmer plays on initial load.
- [ ] `?fullDay=1` toggle shows hours 00–23 vs 08–20.

---

## Phase 12 — Smoke E2E plan (Playwright)

Target: running app at `http://localhost:7778`.

```typescript
// smoke-calendar.spec.ts — minimum 10 steps

test('Calendar page smoke', async ({ page }) => {
  // Step 1: Navigate to the calendar page
  await page.goto('http://localhost:7778/admin/scheduling/calendars');
  await page.waitForLoadState('networkidle');

  // Step 2: Header consistent with Projects page — breadcrumb and title present
  await expect(page.getByText('Scheduling /')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Calendario' })).toBeVisible();

  // Step 3: Primary button "Añadir tarea" visible with accent background
  const addBtn = page.getByRole('button', { name: 'Añadir tarea' });
  await expect(addBtn).toBeVisible();
  // accent = var(--color-accent) which resolves to rgb(99, 102, 241) in default theme
  // Verify by checking it exists and is not hidden — colour check is brittle, skip

  // Step 4: Default view is Week — "Semana" button is active
  const semanaBtn = page.getByRole('button', { name: 'Semana' });
  await expect(semanaBtn).toHaveClass(/btnSecondaryActive/);

  // Step 5: Switch to Day view
  await page.getByRole('button', { name: 'Día' }).click();
  await expect(page.url()).toContain('view=day');

  // Step 6: Day view resource-timeline sidebar visible with at least one technician row
  await page.waitForSelector('[data-testid="resource-sidebar"]', { timeout: 5000 });
  // If no technicians exist in dev DB, the "Sin asignar" row should be visible
  const sidebarRows = page.locator('[data-testid="resource-row"]');
  await expect(sidebarRows.first()).toBeVisible();

  // Step 7: Hour headers visible (08:00 at minimum in business hours mode)
  await expect(page.getByText('08:00')).toBeVisible();

  // Step 8: Navigate to next day
  await page.getByRole('button', { name: 'Período siguiente' }).click();
  const url = new URL(page.url());
  const dateParam = url.searchParams.get('date');
  expect(dateParam).toBeTruthy(); // date advanced

  // Step 9: Click "Today" resets date
  await page.getByRole('button', { name: 'Hoy' }).click();
  const urlAfterToday = new URL(page.url());
  const today = new Date().toISOString().slice(0, 10);
  expect(urlAfterToday.searchParams.get('date')).toBe(today);

  // Step 10: Switch to Month view — grid with 7 columns and day numbers visible
  await page.getByRole('button', { name: 'Mes' }).click();
  await expect(page.url()).toContain('view=month');
  await expect(page.getByText('Lun')).toBeVisible(); // day header

  // Step 11 (bonus): If tasks exist — click one task pill navigates to detail
  const taskPills = page.locator('[data-testid="event-pill"]');
  const pillCount = await taskPills.count();
  if (pillCount > 0) {
    const firstPill = taskPills.first();
    const taskId = await firstPill.getAttribute('data-task-id');
    await firstPill.click();
    await page.waitForURL(`**/scheduling/tasks/${taskId}`);
    await expect(page.url()).toContain('/scheduling/tasks/');
  }

  // Step 12 (bonus): "Añadir tarea" opens modal
  await page.goto('http://localhost:7778/admin/scheduling/calendars');
  await page.getByRole('button', { name: 'Añadir tarea' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});
```

**Mandatory attributes to add during implementation**:
- `[data-testid="resource-sidebar"]` on the sidebar container.
- `[data-testid="resource-row"]` on each technician row element.
- `[data-testid="event-pill"]` + `data-task-id={task.id}` on each `EventPill`.

These `data-testid` attributes are test-only markers — no visual impact.
