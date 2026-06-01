# Technical Design — `scheduling-calendar-view`

## Technical Approach

The calendar page is split into three concerns:
1. **Data layer** — backend date-range filter (additive Zod extension) + frontend `useTasksForCalendar` hook that computes `from`/`to` from current view + date and passes them to the existing `useFilteredTasks`.
2. **State layer** — `useCalendarUrlState` hook owns `view`, `date`, and all filter params in URL search params (no local state). Derived computations (range start/end, label string) are memoised.
3. **Render layer** — three view components (`CalendarMonthView`, `CalendarWeekView`, `CalendarDayView`) each receive resolved `events`, `resources`, and interaction callbacks as props. No data fetching inside view components.

---

## AD-1 — Calendar library choice

### Candidates evaluated

| Option | License | Bundle | Resource-timeline | A11y | Last update | Community |
|--------|---------|--------|-------------------|------|-------------|-----------|
| A — FullCalendar Core (MIT) + Resource Timeline (premium) | Premium plugin ~$480/yr | ~180 kB core + premium | YES (premium only) | Good | Active 2024 | Large |
| B — React Big Calendar | MIT | ~55 kB | NO — no built-in resource rows | Basic | 2023 (slow) | Medium |
| C — Schedule-X v2 | MIT | ~120 kB | YES (since v2) | Moderate | Active 2025 | Small-growing |
| D — Custom CSS Grid | N/A | 0 kB added | YES (built to spec) | Full control | N/A | N/A |

### Analysis

**Option A** is eliminated immediately: the resource-timeline — the entire point of Day/Week views — is locked behind a commercial licence ($480/yr recurring). MIT core only gives month/week/day event grids, which is what the current placeholder already has. Paying for Splynx parity on a small ISP internal tool is not justified.

**Option B** is eliminated: `react-big-calendar` has no resource support at all in its MIT form. We would need to build the resource axis ourselves anyway, giving us all the cost of Option D with the added weight and styling friction of an external library.

**Option C — Schedule-X v2** is viable. It is MIT, supports resource view, and is actively maintained (latest release 2025). Downsides: small community means few answered StackOverflow questions, the theming system uses CSS custom properties that may conflict with ours, and its resource grouping API is less documented. Bundle cost is ~120 kB uncompressed.

**Option D — Custom CSS Grid** is the recommended choice. Rationale:
- Zero bundle cost (no `npm install`).
- Full design-system consistency — every pixel uses `var(--color-accent)`, `var(--color-surface)`, `var(--color-border)`, etc., without fighting a library's class overrides.
- The resource-timeline is structurally simple: a CSS Grid with `grid-template-columns: [sidebar] 240px [hours] repeat(N, minmax(60px, 1fr))`. We have already built similarly complex CSS Grid layouts in this project.
- ARIA is under our control — we know the exact elements and can apply `role`, `aria-label`, `tabIndex` precisely.
- The Splynx snapshot (scheduling-calendar-snapshot.yml) confirms the structure is a flat list of technician rows × hour columns — not a complex recursive tree. There are ~30–40 rows at IPNEXT; no virtualisation is needed at that scale.
- **Fallback**: if the custom implementation takes more than 3 days, switch to Option C (Schedule-X) — the hook interfaces remain identical, only the render layer changes.

**Decision: Option D — Custom CSS Grid.**

---

## AD-2 — Resource grouping

The Splynx snapshot shows resources grouped by team names: "Red", "LOGISTICA", "INSTALACION", "VISITA TECNICA", "Facturacion", "Without teams". These map loosely to `Admin.role` values (`engineer`, `technician`, `support_agent`, etc.).

Introducing a new `category` or `team` column on `Admin` is out of scope for this change (requires schema migration + seed + admin UI). The `Admin.role` enum (`superadmin`, `admin`, `viewer`, `engineer`, `financial_manager`, `support_agent`, `technician`) is used as the grouping proxy.

**Decision: group by `Admin.role`. No schema change.** A future change can introduce a freeform `team` string field on `Admin` to match Splynx exactly.

---

## AD-3 — Time slot granularity

The Splynx snapshot shows hourly columns (00:00, 01:00, … 23:00). Task events span across columns with sub-hour precision (e.g., a task from 09:30 to 11:00 would render as a pill starting at the 30% mark of the 09:00 column).

**Decision: 1-hour column width. Sub-hour precision via `left` offset as a percentage of the column width.** Formula: `left = (startMinutes / 60) * 100%`, `width = ((endMinutes - startMinutes) / 60) * 100%` clamped to column boundaries. This gives visual accuracy without requiring sub-hour columns.

---

## AD-4 — Day view visible hours

Business hours (08:00–20:00) gives 12 visible columns, keeps the grid readable at 1280px, and matches the Splynx reference use case (all technician tasks are daytime).

**Decision: default = 08:00–20:00 (12 columns). A "Full day" toggle switches to 00:00–23:59 (24 columns).** This mirrors the Splynx "Full day" combobox. The toggle state is stored in URL as `?fullDay=1` so it persists on reload.

---

## AD-5 — Event rendering (impeccable design)

Task pills inside the timeline MUST be visually rich but compact:

```
┌─────────────────────────────────────────────┐
│ ● Instalacion del cliente: LANDI GERONIMO   │  ← title, truncated 1 line
│   ACCESO SUR Y CALLE 118                    │  ← address (tiny, muted), only if space
└─────────────────────────────────────────────┘
```

- **Background**: stage category colour — `nuevo` = `#3b82f6` (blue-500), `enProgreso` = `#f59e0b` (amber-500), `hecho` = `#10b981` (emerald-500). These match the Kanban column colours from change 6.
- **Text**: white, `font-size: 12px`, `font-weight: 600`, `overflow: hidden`, `text-overflow: ellipsis`, `white-space: nowrap`.
- **Border-radius**: `var(--radius-md)` (consistent with card system).
- **Hover**: slight brightness increase (`filter: brightness(1.1)`) + cursor pointer.
- **Tooltip** (on hover, via `title` attribute initially; upgrade to CSS tooltip on iteration 2): shows full title + customer name + start/end time.
- **Min-width**: 60px (1 hour column). Pills narrower than this are capped and overflow-hidden.
- **Month view pills**: smaller variant — 6px height colour bar left + title text, no address.

---

## AD-6 — Month view density (impeccable design)

Max 3 task pills per day cell. When count > 3:
- Show 3 pills.
- Show a "+N más" link in `var(--color-accent)` below them.
- Clicking "+N más" navigates to Day view for that date (URL switch), which shows all tasks for that day.

Empty cells: plain background, day number in `var(--color-text-secondary)`. No visual noise.

Day cells are `min-height: 100px`. With 3 pills (each ~22px) + day number (20px) + +N link (18px) + padding = ~100px fits comfortably.

---

## AD-7 — Layout at 1280px (impeccable design)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ HEADER (64px sticky)                                                            │
│  breadcrumb · h1 Calendario            [Añadir tarea] [Filtrar]                │
├─────────────────────────────────────────────────────────────────────────────────┤
│ TOOLBAR (48px sticky)                                                           │
│  [Proyecto ▾] [Etapa ▾] [Socio ▾]  │  ‹ 20 may 2026 ›  [Today]  │  Día Semana Mes │
├──────────────────────────────────────────────────────────────────┬──────────────┤
│ CALENDAR BODY (fill remaining height, overflow: hidden)          │ FILTER PANEL │
│                                                                  │ (260px, when │
│  ┌──────────┬──────────────────────────────────────────────────┐ │  open)       │
│  │ SIDEBAR  │ HOUR HEADER (sticky top)                         │ │              │
│  │ 240px    │ 08:00 09:00 10:00 ... 20:00                      │ │              │
│  │ (sticky  ├──────────────────────────────────────────────────┤ │              │
│  │  left)   │ EVENTS GRID (scroll Y for rows, scroll X for hrs)│ │              │
│  │          │  [task pill]          [task pill]                │ │              │
│  │ [role]   │                                                  │ │              │
│  │ [avatar] │                                                  │ │              │
│  │  name    │                                                  │ │              │
│  └──────────┴──────────────────────────────────────────────────┘ │              │
└──────────────────────────────────────────────────────────────────┴──────────────┘
```

- Toolbar sticks below the global nav (not below the page header — page header scrolls with content).
- Sidebar: `position: sticky; left: 0; z-index: 10; background: var(--color-surface)`. This keeps technician names visible when scrolling hours horizontally.
- Hour header: `position: sticky; top: 0; z-index: 10` within the scrollable grid container.
- Events grid: `overflow-x: auto; overflow-y: auto; flex: 1`.

---

## AD-8 — Layout at 768px (impeccable design)

At 768px:
- Toolbar row wraps: filters go to a second line, or collapse into a single "Filtros" button that opens a drawer.
- Resource sidebar (240px) exceeds available screen real estate at 768px (sidebar alone = 31% of screen). **Collapse to a `<select>` dropdown**: "Todos los técnicos / [Name]". When a specific technician is selected, only that row is shown. Row height expands to fill available width.
- Month view: cell `min-height: 80px`; pills truncated further.
- Day view: if sidebar is collapsed, the hour grid fills full width; the selected technician name shows as a sticky chip at the top.

---

## AD-9 — Filter state and URL schema

```
?view=day|week|month
&date=YYYY-MM-DD
&projectId={id}
&stageIds[]={id}&stageIds[]={id}
&partnerId={id}
&assigneeId={id}
&fullDay=1
```

Default: `view=week`, `date={today}`, no filters, `fullDay` absent (= false).

`useCalendarUrlState` reads all of these from `useSearchParams()`. Write operations use `replace: true` — no history stack entries except intentional forward navigation.

---

## AD-10 — Date math

`date-fns` is NOT in `package.json`. Native `Date` + `Intl.DateTimeFormat` is sufficient for the operations needed:
- Start/end of week: `date - date.getDay()` (Sunday) or `date - ((date.getDay() + 6) % 7)` (Monday-first).
- Start/end of month: `new Date(year, month, 1)` and `new Date(year, month + 1, 0)`.
- Format labels: `Intl.DateTimeFormat('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })`.
- ISO date string: `date.toISOString().slice(0, 10)`.

**Decision: use native Date + Intl. Do NOT install date-fns or moment.**

---

## AD-11 — Empty state visuals (impeccable design)

When no tasks exist in the current range:

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│          [calendar icon, 48px, var(--color-gray-300)]           │
│                                                                 │
│        Sin tareas en este rango.                                │
│    Cargá una nueva o ajustá los filtros.                        │
│                                                                 │
│              [+ Añadir tarea]  (accent button)                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

- Rendered inside the calendar body, replacing the grid.
- Icon: inline SVG calendar shape, `color: var(--color-gray-300)`, `width: 48px`.
- Text: `font-size: 15px`, `color: var(--color-text-secondary)`, centred.
- CTA button re-opens the create-task modal with no pre-fill.

---

## AD-12 — Loading skeleton (impeccable design)

**Day/Week view skeleton** — while `isLoading` is true:
- Sidebar renders 6–8 skeleton rows: grey rounded rect 32px tall × full sidebar width, animated `background: linear-gradient(90deg, var(--color-gray-100) 25%, var(--color-gray-50) 50%, var(--color-gray-100) 75%)` with `background-size: 400% 100%` + `animation: shimmer 1.5s infinite`.
- Grid area shows same shimmer overlay.

**Month view skeleton**:
- 35 cells rendered. Each cell has a shimmer rect where the day number would be, plus 2 shimmer pill shapes.

The skeleton renders in the same grid container as the real view — no layout shift when data arrives.

---

## Data Flow Diagram

```
URL params (?view, ?date, ?projectId, ?stageIds[], ?partnerId, ?assigneeId, ?fullDay)
     │
     ▼
useCalendarUrlState()
  ├── view: 'day' | 'week' | 'month'
  ├── date: Date
  ├── filter: TaskListFilter (projectId, stageIds, partnerId, assigneeId)
  ├── fullDay: boolean
  ├── setView(), setDate(), setFilter(), toggleFullDay()
  └── from, to: string (ISO, derived from view+date)
     │
     ▼
useTasksForCalendar(filter, from, to)
  └── useFilteredTasks({ ...filter, from, to })
          │
          ▼  GET /api/scheduling?...&from=&to=
     TanStack Query cache
          │
          ▼
     tasks: ScheduledTask[]
          │
     ┌────┴──────────────────────────────────┐
     ▼                                       ▼
CalendarDayView / CalendarWeekView     CalendarMonthView
  useTechnicians() → resources          group tasks by date
  group by role                         render month grid
  map tasks to CalendarEvent[]
  render CSS Grid resource-timeline
```

---

## TypeScript Interfaces

```typescript
// Calendar-specific types — lives in src/types/calendar.ts

export type CalendarView = 'day' | 'week' | 'month';

export interface CalendarEvent {
  id: string;
  title: string;
  start: Date;           // derived from task.startDate
  end: Date;             // derived from task.endDate (fallback: start + estimatedHours)
  resourceId: string;    // task.assigneeId ?? 'unassigned'
  stageCategory: 'nuevo' | 'enProgreso' | 'hecho';
  customerName?: string;
  address?: string;
}

export interface CalendarResource {
  id: string;
  name: string;
  initials: string;      // derived: first letter of each word, max 3 chars
  role: string;          // Admin.role value — used as group key
}

export interface CalendarUrlState {
  view: CalendarView;
  date: Date;
  from: string;          // ISO datetime, derived
  to: string;            // ISO datetime, derived
  filter: TaskListFilter;
  fullDay: boolean;
  setView: (v: CalendarView) => void;
  setDate: (d: Date) => void;
  setFilter: (patch: Partial<TaskListFilter>) => void;
  toggleFullDay: () => void;
  goNext: () => void;
  goPrev: () => void;
  goToday: () => void;
}
```

---

## File Changes

### Backend

| File | Delta |
|------|-------|
| `src/application/dto/scheduling.dto.ts` | ADD `from`/`to` optional fields to `ListTasksFilterSchema` |
| `src/application/use-cases/ListTasks.ts` | ADD `startDate: { gte: from, lte: to }` Prisma where clause |
| `src/infrastructure/http/routes/scheduling.routes.ts` | Extract `from`/`to` from `req.query`, pass to filter schema |
| `src/__tests__/application/ListTasks.test.ts` | ADD test cases for date range filter |

### Frontend

| File | Delta |
|------|-------|
| `src/types/scheduling.ts` | ADD `from?: string; to?: string` to `TaskListFilter` |
| `src/api/scheduling.api.ts` | ADD `from`/`to` to `buildFilterParams` |
| `src/types/calendar.ts` | NEW — `CalendarView`, `CalendarEvent`, `CalendarResource`, `CalendarUrlState` |
| `src/pages/scheduling/SchedulingCalendarPage.tsx` | REWRITE — sibling re-export shim |
| `src/pages/scheduling/SchedulingCalendarPage/index.tsx` | NEW — page component |
| `src/pages/scheduling/SchedulingCalendarPage/SchedulingCalendarPage.module.css` | NEW — CSS module |
| `src/pages/scheduling/SchedulingCalendarPage/hooks/useCalendarUrlState.ts` | NEW |
| `src/pages/scheduling/SchedulingCalendarPage/hooks/useTasksForCalendar.ts` | NEW |
| `src/pages/scheduling/SchedulingCalendarPage/components/CalendarToolbar.tsx` | NEW |
| `src/pages/scheduling/SchedulingCalendarPage/components/CalendarToolbar.module.css` | NEW |
| `src/pages/scheduling/SchedulingCalendarPage/components/CalendarMonthView.tsx` | NEW |
| `src/pages/scheduling/SchedulingCalendarPage/components/CalendarMonthView.module.css` | NEW |
| `src/pages/scheduling/SchedulingCalendarPage/components/CalendarWeekView.tsx` | NEW |
| `src/pages/scheduling/SchedulingCalendarPage/components/CalendarWeekView.module.css` | NEW |
| `src/pages/scheduling/SchedulingCalendarPage/components/CalendarDayView.tsx` | NEW |
| `src/pages/scheduling/SchedulingCalendarPage/components/CalendarDayView.module.css` | NEW |
| `src/pages/scheduling/SchedulingCalendarPage/components/EventPill.tsx` | NEW — shared pill between day/week views |
| `src/pages/scheduling/SchedulingCalendarPage/components/ResourceSidebar.tsx` | NEW — sidebar for day/week views |
| `src/__tests__/scheduling/SchedulingCalendarPage.test.tsx` | NEW |

---

## Testing Strategy

### Backend
- **Unit**: `ListTasks` use case with `InMemorySchedulingRepository`. Scenarios: `from` only, `to` only, both, neither, invalid format (expect Zod error before use case is called).
- **Integration**: route test via `supertest` — `GET /api/scheduling?from=...&to=...` returns filtered tasks.

### Frontend
- **Component (Vitest + RTL)**:
  - `CalendarToolbar`: renders period label; clicking next/prev fires callbacks; view buttons toggle active state.
  - `CalendarMonthView`: renders correct number of cells; tasks appear in correct cell; "+N más" renders when > 3.
  - `CalendarDayView`: renders technician rows; task pill spans correct columns; empty-state renders when no tasks.
  - `SchedulingCalendarPage` (integration): URL sync — initial render reads `?view=day&date=...`; switching view updates URL.
- **Smoke E2E (Playwright)**: see tasks.md.

---

## Open Questions

1. **Technician filter in toolbar**: Should the toolbar include an "Assignee" filter dropdown (to scope the resource-timeline to one technician)? The Splynx snapshot shows "Todos/as" in a combobox. Recommended: YES — add assignee filter matching `useTasksFilterUrl` pattern. The `assigneeId` param already exists in the backend filter.

2. **Week view: Mon–Sun or Sun–Sat?**: Argentina standard is Monday-first. Recommend Mon–Sun for week view.

3. **Create-task modal**: The current `SchedulingTasksPage` creates tasks via a modal. Should the calendar reuse the same modal component or implement a lighter inline form? Recommend reusing the existing modal if it already accepts `startDate`/`assigneeId` pre-fill props. This needs verification when implementing.

4. **No-assignee grouping in resource-timeline**: "Sin asignar" row at bottom or top? Recommend bottom, matching Splynx "Without teams" placement in the snapshot.
