# Proposal: Scheduling Tasks Views

## Intent

The scheduling module has no dedicated task list page. The dashboard shows a basic top-10 table and the projects page links to `/admin/scheduling?projectId=…` which goes nowhere useful. Splynx exposes two complementary views over the full task list at `/admin/scheduling/tasks`:

1. **Tabla** — sortable, paginated table with multi-select filters (Project, Stage multi-select grouped by category, Partner, Assignee search, free-text search). Bulk actions: move stage, delete.
2. **Flujo de Trabajo (Kanban)** — columns = stages of the selected project's workflow; cards = tasks; drag a card to a different column calls `PATCH /api/scheduling/:id/stage`.

This is the **sixth and final** change of the 6-change Splynx Scheduling replica plan (`md/splynx-scheduling/OVERVIEW.md`). It closes the missing link between the data-rich task model built in changes 1–5 and a usable task management UI.

The backend gap is intentionally minimal: extend `GET /api/scheduling` to accept filter query parameters. All new code is frontend-heavy. The skill `impeccable` is applied to the Kanban visual design — column headers, card anatomy, priority pills, drag-over states, and spacing all receive explicit token-level specification.

---

## Scope

### In Scope

#### Frontend (primary deliverable)

- New page `SchedulingTasksPage` at route `/admin/scheduling/tasks` (index, NOT `/tasks/:id` which already exists for detail)
- Lazy-loaded in `App.tsx` alongside the existing scheduling routes
- **Top bar**: Project select (single), Stage multi-select grouped by category (nuevo / enProgreso / hecho), Partner select, Assignee search field, free-text `q` search, view toggle (Tabla / Flujo de Trabajo), "Añadir" button
- **Table view** (`TasksTableView`):
  - Reuses existing `DataTable` organism (already supports `selectable`, `sortable`, `actions`)
  - Columns: Seq# / Stage / Project / Address / Customer / Start Date / Assignee / Priority / Age / Actions
  - Client-side sort (all columns); pagination (25/50/100 page sizes)
  - Bulk-select: checkbox column, sticky action bar appears when ≥ 1 row selected; actions: Move Stage (opens mini-modal with stage select), Delete (confirm)
- **Kanban view** (`TasksKanbanView`):
  - Columns derived from selected project's workflow stages (loaded via `useWorkflow`)
  - If no project is selected, Kanban shows a "Seleccioná un proyecto para ver el Flujo de Trabajo" empty prompt (AD-2)
  - Card anatomy: `#sequenceNumber` + title, priority pill, assignee name/avatar initials, age, customer line
  - Drag card → drop on another column → `PATCH /api/scheduling/:id/stage` with optimistic UI (snapshot + rollback, AD-4)
  - dnd-kit (already installed from change 5); Pointer + Keyboard sensors
  - Horizontal scroll on viewports < 1280px; minimum column width 240px
- **URL sync**: filter state (projectId, stageIds, partnerId, assigneeId, q, view) synced to URL search params via `useSearchParams`; debounce 300ms; `replace` not `push` (AD-10)
- **Filter chip bar**: active filters rendered as removable chips below the top bar
- Loading skeleton, per-view error state, per-view empty state
- New hook `useFilteredTasks(filter: TaskFilter)` replaces the bare `useTasks()` call for this page; propagates filter to the API call
- Vitest tests: render both views, toggle view, apply filter, drop a card (mock dnd-kit), optimistic UI rollback, URL sync, a11y roles

#### Backend (gap-fill only)

- `GET /api/scheduling` extended to accept query params: `?projectId=&stageIds=a,b,c&partnerId=&assigneeId=&q=`
- New `ListTasksFilterSchema` (zod) in `src/application/dto/scheduling.dto.ts`
- `ListTasks` use case accepts optional `TaskListFilter` object; defaults to empty (backward-compatible)
- `SchedulingRepository.listTasks` signature widened to `listTasks(filter?: TaskListFilter): Promise<ScheduledTask[]>`
- `PrismaSchedulingRepository.listTasks` builds Prisma `where` clause from filter
- `InMemorySchedulingRepository.listTasks` applies same filter logic in-memory (for existing tests)
- Route handler parses query params with the new schema before calling use case
- Existing tests pass unchanged (empty filter = list all — same behaviour as today)
- New Jest test: route returns filtered subset when `?stageIds=` param provided

### Out of Scope

- Removing deprecated columns (`status`, `scheduledDate`, `scheduledTime`, `clientId`, `clientName`, `assignedTo`, `assignedToId`) — kept for one release per change 1; cleanup is a separate future change
- Mobile (≤ 480px) full optimization beyond horizontal scroll
- Multi-workflow Kanban when no project is selected — decided in AD-2: require project selection
- Saved filter sets / filter presets
- Real-time updates via websockets or server-sent events
- `projects.routes.ts` auth fix — already pulled forward into change 2 (design AD-10) per lesson 11

---

## Capabilities

### New Capabilities

- `scheduling-tasks-views`: Frontend capability — route `/admin/scheduling/tasks`, dual view (table + kanban), filter state in URL, optimistic drag-drop. New spec file at `openspec/changes/scheduling-tasks-views/specs/scheduling-tasks-views/spec.md`.

### Modified Capabilities

- `scheduling`: `GET /api/scheduling` now accepts optional filter query params. Delta added to `openspec/changes/scheduling-tasks-views/specs/scheduling-tasks-views/spec.md` (REQ-FILTER-* and REQ-LIST-FILTER-VAL-*). The consolidated scheduling spec at `openspec/specs/scheduling/spec.md` should be updated in the archive step.

---

## Approach

1. **Backend DTO**: add `ListTasksFilterSchema` to `scheduling.dto.ts`. Export `TaskListFilter` type.
2. **Backend port**: widen `SchedulingRepository.listTasks(filter?: TaskListFilter)` — optional to preserve backward compatibility.
3. **Backend use case**: `ListTasks.execute(filter?: TaskListFilter)` passes through to repo.
4. **Backend adapter (Prisma)**: build `where` from filter — stageIds as `stageId: { in: [...] }`, projectId, partnerId, assigneeId, `q` against title (case-insensitive `contains`).
5. **Backend adapter (in-memory)**: apply same filter predicates on the in-memory array.
6. **Backend route**: parse `req.query` with `ListTasksFilterSchema.safeParse`, call use case with parsed filter, return 400 on validation error.
7. **Backend tests**: unit test for Prisma filter query construction (in-memory port); integration test via supertest verifying filtered response.
8. **Frontend types**: extend `src/api/scheduling.api.ts` to accept filter params; update `listTasks` API function.
9. **Frontend hook**: `useFilteredTasks(filter)` — `useQuery` with `queryKey: ['scheduling-tasks', filter]` and `refetchInterval: 30_000`. Old `useTasks()` hook is kept untouched for other pages.
10. **Frontend page scaffold**: `SchedulingTasksPage` — top bar, view state, URL sync hook, filter chip bar. Register lazy route in `App.tsx` at `/admin/scheduling/tasks` (before the existing `/:id` route — order matters to avoid shadowing).
11. **Frontend table view**: `TasksTableView` wires existing `DataTable` with the new column defs, adds bulk action bar.
12. **Frontend Kanban view**: `TasksKanbanView`, `KanbanColumn`, `KanbanCard` — dnd-kit `DndContext` wrapping all columns, `useDroppable` on columns, `useDraggable` on cards. `useMoveTaskToStage` mutation with snapshot/rollback.
13. **Frontend URL sync hook**: `useTasksFilterUrl()` — reads/writes `useSearchParams` with debounce.
14. **Frontend tests**: Vitest + @testing-library/react — render, toggle, filter, drag-drop mock.

---

## Affected Areas

### Backend

| File | Change |
|------|--------|
| `src/application/dto/scheduling.dto.ts` | Add `ListTasksFilterSchema`, `TaskListFilter` export |
| `src/domain/ports/SchedulingRepository.ts` | Widen `listTasks` signature |
| `src/application/use-cases/ListTasks.ts` | Accept and forward `TaskListFilter` |
| `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts` | Prisma `where` from filter |
| `src/infrastructure/adapters/in-memory/InMemorySchedulingRepository.ts` | In-memory filter predicates |
| `src/infrastructure/http/routes/scheduling.routes.ts` | Parse `req.query`, pass filter to use case |
| `src/__tests__/infrastructure/scheduling.routes.filter.test.ts` | New — integration tests for filtered GET |

### Frontend

| File | Change |
|------|--------|
| `src/App.tsx` | Register `SchedulingTasksPage` at `/admin/scheduling/tasks` (before `/:id`) |
| `src/api/scheduling.api.ts` | Extend `listTasks` to accept filter params |
| `src/hooks/useScheduling.ts` | Add `useFilteredTasks(filter)` hook |
| `src/pages/scheduling/SchedulingTasksPage/index.tsx` | New page |
| `src/pages/scheduling/SchedulingTasksPage/SchedulingTasksPage.module.css` | New |
| `src/pages/scheduling/SchedulingTasksPage/components/TasksTableView.tsx` | New |
| `src/pages/scheduling/SchedulingTasksPage/components/TasksTableView.module.css` | New |
| `src/pages/scheduling/SchedulingTasksPage/components/TasksKanbanView.tsx` | New |
| `src/pages/scheduling/SchedulingTasksPage/components/TasksKanbanView.module.css` | New |
| `src/pages/scheduling/SchedulingTasksPage/components/KanbanColumn.tsx` | New |
| `src/pages/scheduling/SchedulingTasksPage/components/KanbanColumn.module.css` | New |
| `src/pages/scheduling/SchedulingTasksPage/components/KanbanCard.tsx` | New |
| `src/pages/scheduling/SchedulingTasksPage/components/KanbanCard.module.css` | New |
| `src/pages/scheduling/SchedulingTasksPage/components/TaskFilterBar.tsx` | New |
| `src/pages/scheduling/SchedulingTasksPage/components/TaskFilterBar.module.css` | New |
| `src/pages/scheduling/SchedulingTasksPage/hooks/useTasksFilterUrl.ts` | New |
| `src/__tests__/scheduling/SchedulingTasksPage.test.tsx` | New |

**`app.ts` touch**: NO. The backend route change is self-contained inside `scheduling.routes.ts`; the existing `ListTasks` use case instance wired in `app.ts` needs no change to its construction — it receives no constructor args (just the repo). The route handler will call `listTasks.execute(filter)` with the new optional arg. No new wiring in `app.ts` required.

---

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Route `/admin/scheduling/tasks` (index) shadows the existing `/admin/scheduling/tasks/:id` (detail) if registered after it in React Router | High | Register the new index route BEFORE `tasks/:id` in `App.tsx` — tasks.md step 5 specifies this order explicitly |
| Optimistic UI diverges from server state when concurrent users move cards simultaneously | Medium | `refetchInterval: 30_000` on the query + `onError` rollback via snapshot (AD-4 and AD-5); no real-time guarantee in v1 |
| Backend filter using `?stageIds=a,b` (comma-separated string) is fragile across URL encoders | Low | Spec uses `stageIds` as a repeated query param (`?stageIds=a&stageIds=b`) parsed by zod `z.array(z.string().min(1)).optional()` from `req.query.stageIds` (Express parses `?stageIds[]=a&stageIds[]=b` OR repeated keys to array) — design locks the exact wire format |
| dnd-kit `useDroppable` on columns and `useDraggable` on cards conflicts with `SortableContext` used in ChecklistSection | None | Checklist uses `SortableContext` within a list; Kanban uses standalone `useDroppable` + `useDraggable` — different dnd-kit APIs, no shared context |
| `DataTable` `selectable` prop triggers `onSelectionChange` on every toggle; bulk action bar rerenders the whole table | Low | Bulk action bar is a sibling, not a child of `DataTable`; lifted state at `TasksTableView` level; memoize with `useCallback` |

---

## Frontend Coordination

- `useFilteredTasks` is a NEW hook; existing `useTasks()` used by `SchedulingDashboardPage` is untouched
- `listTasks` API function gains an optional second param `filter?: TaskListFilter` defaulting to `{}` — no existing callers break
- View toggle state is local to `SchedulingTasksPage` and reflected in `?view=table|kanban` URL param; other pages are unaffected
- `App.tsx` edit is a single lazy-import + one `<Route>` element; route order is specified in tasks.md

---

## Rollback Plan

Frontend-only rollback: remove the `<Route>` for `/admin/scheduling/tasks` from `App.tsx` and the lazy import; delete the `SchedulingTasksPage/` directory. No DB changes, no migrations.

Backend rollback: revert `scheduling.dto.ts`, `SchedulingRepository.ts`, `ListTasks.ts`, `PrismaSchedulingRepository.ts`, `scheduling.routes.ts`. The `GET /api/scheduling` handler reverts to `listTasks.execute()` with no args. All existing data is unaffected.

---

## Dependencies

- Changes 1–5 must be deployed: `scheduling-foundation-stage-model`, `scheduling-projects-enrich`, `scheduling-tasks-enrich`, `scheduling-task-detail-page`, `scheduling-checklists`
- `dnd-kit` (`@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`) installed in change 5 — confirmed present
- Backend: `PATCH /api/scheduling/:id/stage` already exists (change 1) — no new endpoint needed for Kanban drops
- Frontend: `useWorkflows`, `useWorkflow` hooks exist in `src/hooks/useWorkflows.ts` — reused as-is
- Frontend: `DataTable` organism supports `selectable` + `actions` — confirmed in source

---

## Success Criteria

- [ ] `GET /api/scheduling?stageIds[]=<id1>&stageIds[]=<id2>` returns only tasks in those stages
- [ ] `GET /api/scheduling?projectId=<id>` returns only tasks for that project
- [ ] `GET /api/scheduling` (no params) returns all tasks — backward-compatible
- [ ] `tsc --noEmit` clean in both repos
- [ ] `npm test` green in both repos
- [ ] `/admin/scheduling/tasks` renders without error; default view is Table
- [ ] View toggle switches between Table and Kanban; URL param `?view=` updates
- [ ] Filter selections update URL params (debounced) and re-fetch tasks
- [ ] Kanban shows "Seleccioná un proyecto" prompt when no project is selected
- [ ] Kanban drag-drop updates card's column optimistically; server confirms via PATCH; rollback on error
- [ ] Bulk select in Table view: selecting rows shows action bar; Move Stage and Delete work
- [ ] All Vitest tests pass; keyboard drag test confirms dnd-kit Keyboard sensor responds
- [ ] No import of `@infrastructure/*` from `@application/*` (DIP preserved)
- [ ] New route in `App.tsx` is registered before `/admin/scheduling/tasks/:id`
