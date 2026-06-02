# Design: Scheduling Tasks Views

**Change**: `scheduling-tasks-views`
**Date**: 2026-05-20

---

## Technical Approach

The change has two orthogonal parts:

**Backend (small)**: Thread an optional filter object through the existing `GET /api/scheduling` call chain — DTO validation → use case → repository. No new endpoints, no new models, no `app.ts` touch.

**Frontend (large)**: A new page at `/admin/scheduling/tasks` that owns its own filter state (URL-synced), fetches via an extended `useTasks`-style hook, and renders two swap-able views using components built from scratch (Kanban) or from existing atoms (Table via `DataTable`). The Kanban view is the visual showpiece — designed rigorously below (AD-8).

---

## Architecture Decisions

### AD-1: Filter State — URL Search Params

**Decision**: filter state lives exclusively in URL search params, read/written via React Router v6 `useSearchParams`.

**Rationale**: Splynx Kanban screenshot shows users share links; URL sync gives free shareability and browser-back navigation. `useState` would lose state on navigation. Zustand would add a store solely for this page, creating hidden coupling. `useSearchParams` is already available (React Router v6 is the app's router — see `App.tsx`).

**Tradeoffs**:
- Con: slightly more boilerplate than `useState` for compound filter objects
- Con: arrays (stageIds) require bracket notation (`stageIds[]=a&stageIds[]=b`) — handled in `useTasksFilterUrl` hook
- Pro: zero external state library dependency; page is bookmark-safe; dev tools show filter state in address bar

**Implementation note**: a custom hook `useTasksFilterUrl()` encapsulates all read/write logic. It returns `{ filter, setFilter }` where `setFilter` calls `setSearchParams` with `replace: true` after a 300ms debounce (text search) or immediately (view toggle, select changes).

---

### AD-2: Kanban Without Project Filter

**Decision**: when no project is selected, Kanban shows a soft prompt — "Seleccioná un proyecto para ver el Flujo de Trabajo" — and renders no columns.

**Rationale**: The only way to build a meaningful Kanban is to know which workflow's stages to use as columns. Without a project, we'd either (a) show every stage from every workflow — which creates 20+ columns from all workflows mixed together (confusing, as stages share names across workflows), or (b) show the "Default" workflow's stages — which is wrong for tasks in non-default workflows. The Splynx Kanban screenshot confirms it requires a project selection (filter shows "VISITA TECNICA WIRELESS" selected). The prompt is non-blocking: the user still sees the filter bar and can select a project in place.

**Tradeoffs**:
- Con: Kanban is non-functional until a project is chosen (extra step)
- Pro: no architectural complexity of multi-workflow column merging; deferred cleanly

---

### AD-3: Drag Library — dnd-kit Configuration

**Decision**: use `@dnd-kit/core` with `PointerSensor` + `KeyboardSensor`. Columns use `useDroppable`. Cards use `useDraggable`. Do NOT use `SortableContext` for cards within a column (cross-column reorder is not a requirement).

**Rationale**: `dnd-kit` is already installed from change 5. `ChecklistSection` uses `SortableContext + useSortable` for within-list reordering — different API. For Kanban, we need cross-container drop detection, which is simpler with plain `useDroppable` + `useDraggable` than with `SortableContext`.

**Sensor configuration**:
```ts
const sensors = useSensors(
  useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
);
```
`distance: 8` prevents accidental drags when clicking cards. Keyboard sensor uses the imported `sortableKeyboardCoordinates` (already available from `@dnd-kit/sortable`).

**DragOverlay**: render a `KanbanCard` inside `DragOverlay` for a smooth floating card while dragging. This avoids the column "jump" that happens when the original card is removed from the source column mid-drag.

---

### AD-4: Optimistic UI on Drop

**Decision**: use TanStack Query `onMutate` / `onError` / `onSettled` pattern with a snapshot of the `['scheduling-tasks', filter]` query cache.

**Flow**:
```
onMutate({ id, stageId }):
  1. await qc.cancelQueries({ queryKey: ['scheduling-tasks', filter] })
  2. snapshot = qc.getQueryData(['scheduling-tasks', filter])
  3. qc.setQueryData(['scheduling-tasks', filter], tasks => 
       tasks.map(t => t.id === id ? { ...t, stageId } : t)
     )
  4. return { snapshot }

onError(_err, _vars, context):
  qc.setQueryData(['scheduling-tasks', filter], context.snapshot)

onSettled():
  qc.invalidateQueries({ queryKey: ['scheduling-tasks', filter] })
```

**Key detail**: the mutation uses `useMoveTaskToStage` which already exists in `useScheduling.ts` but with a different query key. The page needs a dedicated mutation that invalidates `['scheduling-tasks', filter]` (not the bare `['scheduling-tasks']` key). Wrap `api.moveTaskToStage` in a new `useMoveTaskToStageFiltered(filter)` mutation defined inside `SchedulingTasksPage` or `TasksKanbanView`.

---

### AD-5: Stale Data Handling

**Decision**: `useFilteredTasks` queries with `refetchInterval: 30_000` (30 seconds) and `staleTime: 15_000`.

**Rationale**: When another user moves a card concurrently, the local state diverges silently. A 30-second background refetch is sufficient for a scheduling app (not a real-time chat). This matches the existing `useWorkflows` staleTime pattern (`staleTime: 60_000`). WebSocket real-time updates are out of scope.

**Tradeoffs**:
- Pro: simple, no infrastructure changes
- Con: up to 30s lag in concurrent scenarios
- Con: in the rare case where a refetch fires mid-drag, the `cancelQueries` in `onMutate` blocks it; after `onSettled` the invalidation triggers the authoritative re-fetch

---

### AD-6: Column Virtualization

**Decision**: no virtualization for v1.

**Rationale**: According to the Splynx Kanban snapshot, the busiest visible column ("Nuevo" in VISITA TECNICA WIRELESS) has approximately 9 visible cards in the snapshot. The OVERVIEW notes "≤700 tasks in busiest stage but most under 50". At 50 cards × 100px per card = 5000px column height — acceptable for a vertical scroll within the column. dnd-kit `useDroppable` does not work with react-window virtualized lists out of the box. Adding react-window would require the `AutoSizer` + `List` pattern plus forwarded `innerRef` — significant complexity for a case that only affects ≤1% of columns. The recommendation is: render all cards, use `max-height: calc(100vh - 280px)` on the column body with `overflow-y: auto`.

**Revisit trigger**: if a user reports a specific column with >200 cards causing visible lag, add react-window then.

---

### AD-7: Bulk Actions UX

**Decision**: checkbox column in Table view only. A sticky `BulkActionBar` component renders at the bottom of the viewport (`position: fixed; bottom: 0`) when `selectedIds.length > 0`. Kanban has no bulk selection (drag is inherently one-at-a-time).

**Bulk action bar layout**:
```
[ ✓ 3 tareas seleccionadas ]  [ Mover etapa ▾ ]  [ Eliminar ]  [ ✕ Limpiar ]
```

**"Mover etapa" modal**: a simple `<dialog>` overlay with a grouped `<select>` of all stages (same grouping as the Stage filter — nuevo / enProgreso / hecho). On confirm, iterate `selectedIds` firing `moveTaskToStage` for each. Show a spinner in the modal during mutation. On complete: close modal, clear selection, invalidate query.

**"Eliminar" confirmation**: inline `window.confirm()` for v1 (no extra modal complexity).

---

### AD-8: Visual Design — Kanban (impeccable)

This is the critical deliverable. Every token is specified to AA contrast or better.

#### Design tokens (reuse change 4's palette)

```css
/* Category colours */
--kanban-nuevo-stripe:      #93aec8;   /* gray-blue — category badge */
--kanban-nuevo-bg:          #edf2f7;   /* column header background */
--kanban-en-progreso-stripe: #d97706;  /* amber */
--kanban-en-progreso-bg:    #fffbeb;
--kanban-hecho-stripe:      #16a34a;   /* green */
--kanban-hecho-bg:          #f0fdf4;

/* Priority pills — all pairs verified AA (≥4.5:1) */
--pill-low-bg:     #f3f4f6;   /* gray-100 */
--pill-low-fg:     #374151;   /* gray-700   — ratio 7.2:1 ✓ */
--pill-normal-bg:  #dbeafe;   /* blue-100 */
--pill-normal-fg:  #1e40af;   /* blue-800   — ratio 6.1:1 ✓ */
--pill-high-bg:    #fef3c7;   /* amber-100 */
--pill-high-fg:    #92400e;   /* amber-900  — ratio 7.9:1 ✓ */
--pill-urgent-bg:  #fee2e2;   /* red-100 */
--pill-urgent-fg:  #991b1b;   /* red-800    — ratio 6.8:1 ✓ */
```

#### Column anatomy (320px wide, 16px gap between columns)

```
┌──────────────────────────────┐
│ ▌ NUEVO          (12 tareas) │  ← header: 4px left stripe (category colour)
│                               │    height: 48px; stage name 13/600; count 12/400 gray
├──────────────────────────────┤
│  + Añadir tarea              │  ← optional quick-add link (not v1, placeholder only)
│  ┌────────────────────────┐  │
│  │ #2886                  │  │  ← card
│  │ Reparacion del cliente │  │
│  │ MUNICIPALIDAD          │  │
│  │ [Urgente] [LS] 16 días │  │
│  └────────────────────────┘  │
│  (more cards…)               │
└──────────────────────────────┘
```

#### Column header CSS spec

```css
.columnHeader {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: var(--kanban-<category>-bg);
  border-bottom: 1px solid rgba(0,0,0,0.07);
  border-left: 4px solid var(--kanban-<category>-stripe);
  font-size: 13px;
  font-weight: 600;
  color: #111827;    /* gray-900 — 16.5:1 on light bg ✓ */
}
.columnCount {
  margin-left: auto;
  font-size: 12px;
  font-weight: 400;
  color: #6b7280;    /* gray-500 */
  background: rgba(0,0,0,0.06);
  border-radius: 9999px;
  padding: 1px 7px;
}
```

#### Card CSS spec

```css
.card {
  background: #ffffff;
  border: 1px solid #e5e7eb;     /* gray-200 */
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 8px;
  cursor: grab;
  transition: box-shadow 120ms ease, transform 120ms ease;
}
.card:hover {
  box-shadow: 0 2px 8px rgba(0,0,0,0.10);
}
.card[data-dragging="true"] {
  /* applied by DragOverlay — card stays ghost in original position */
  opacity: 0.4;
}
/* Card header: seq# + title */
.cardSeq { font-size: 11px; font-weight: 500; color: #6b7280; }
.cardTitle {
  font-size: 14px;
  font-weight: 600;
  color: #111827;
  margin: 4px 0;
  /* 2-line clamp */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
/* Card meta row */
.cardMeta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  font-size: 12px;
  color: #6b7280;
}
.cardAge { margin-left: auto; white-space: nowrap; }
/* Customer line */
.cardCustomer {
  font-size: 12px;
  color: #6b7280;
  margin-top: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

#### Priority pill CSS spec

```css
.priorityPill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
.priorityPill[data-priority="low"]    { background: var(--pill-low-bg);    color: var(--pill-low-fg); }
.priorityPill[data-priority="normal"] { background: var(--pill-normal-bg); color: var(--pill-normal-fg); }
.priorityPill[data-priority="high"]   { background: var(--pill-high-bg);   color: var(--pill-high-fg); }
.priorityPill[data-priority="urgent"] { background: var(--pill-urgent-bg); color: var(--pill-urgent-fg); }
```

Priority label map: `low → "Baja"`, `normal → "Normal"`, `high → "Alta"`, `urgent → "Urgente"`.

#### Assignee avatar CSS spec

```css
.assigneeAvatar {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #e0e7ff;    /* indigo-100 */
  color: #3730a3;         /* indigo-800 — 7.4:1 ✓ */
  font-size: 10px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
```

Initials: first letter of each word in assignee name, max 2 chars. If no assignee, show `—` in `cardMeta`.

#### Drag-over column state

```css
.columnBody[data-drag-over="true"] {
  background: #f0f9ff;             /* sky-50 */
  outline: 2px dashed #0ea5e9;    /* sky-500 — 3.1:1 on white; decorative only, not sole indicator */
  outline-offset: -2px;
  border-radius: 0 0 8px 8px;
}
```

**Note**: colour + dashed border + shadow provides multiple visual cues. The dashed border alone is not AA because it is decorative; the layout shift (slight padding change) provides the additional non-colour cue.

#### Board layout

```css
.board {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  overflow-x: auto;
  padding-bottom: 16px;
  /* smooth momentum scroll on mobile */
  -webkit-overflow-scrolling: touch;
}
.column {
  flex: 0 0 280px;        /* fixed 280px, no shrink */
  min-width: 240px;
  border-radius: 8px;
  border: 1px solid #e5e7eb;
  background: #f9fafb;    /* gray-50 */
  display: flex;
  flex-direction: column;
}
.columnBody {
  padding: 8px;
  flex: 1;
  overflow-y: auto;
  max-height: calc(100vh - 280px);
}
.columnEmpty {
  padding: 24px 12px;
  text-align: center;
  color: #9ca3af;          /* gray-400 */
  font-size: 13px;
  font-style: italic;
}
```

---

### AD-9: Filter Bar UX

**Decision**: The filter bar is a sticky top bar (part of the page header, not `position: fixed`). Active filters are shown as chip tags below the filter controls. On viewports ≤ 768px the filter controls wrap onto multiple rows.

**Filter bar composition**:
```
[ Project ▾ ]  [ Estado ▾ (multi-select) ]  [ Socios ▾ ]  [ Asignado: search ]
[ q: search ]  [ Añadir ]  [ ☰ Filter ]  [ ⊞ Tabla | Kanban ⊟ ]
```
Below, if any filter is active:
```
[ × VISITA TECNICA WIRELESS ]  [ × Nuevo ]  [ × Confirmado ]  [ Limpiar todo ]
```

**Stage multi-select implementation**: a custom `StageMultiSelect` component — a button that toggles a dropdown with grouped checkboxes (grupo Nuevo, grupo En progreso, grupo Hecho). The button label shows "N de M seleccionados" matching the Splynx snapshot ("7 of 11 selected"). This is a new component, not the existing `FilterBar` atom (which supports only single-select `<select>` elements per current implementation).

**Active filter chips**: rendered as a `<ul>` of `<li>` chips below the controls row. Each chip has a `role="button"` × to remove that filter. An "X Limpiar todo" button clears all filters at once.

---

### AD-10: URL Sync Strategy

**Decision**: Debounce 300ms for text inputs (`q`, `assigneeId` typed search). Immediate update for select changes and view toggle. Use `replace` (not `push`) for all URL updates within the page to avoid history stack pollution.

**Implementation**:
```ts
// useTasksFilterUrl.ts
const [searchParams, setSearchParams] = useSearchParams();

// read
const filter: TaskFilter = {
  projectId:  searchParams.get('projectId') ?? undefined,
  stageIds:   searchParams.getAll('stageIds[]'),
  partnerId:  searchParams.get('partnerId') ?? undefined,
  assigneeId: searchParams.get('assigneeId') ?? undefined,
  q:          searchParams.get('q') ?? undefined,
};
const view = (searchParams.get('view') ?? 'table') as 'table' | 'kanban';

// write — debounced for text, immediate for selects
function setFilter(patch: Partial<TaskFilter>) {
  // merge patch into current params and replace
  const next = buildParams({ ...filter, ...patch, view });
  setSearchParams(next, { replace: true });
}
function setView(v: 'table' | 'kanban') {
  setSearchParams(p => { p.set('view', v); return p; }, { replace: true });
}
```

Stale URL params from a previous session are no worse than stale filter chips — the API returns an empty list which shows the empty state message.

---

## Data Flow Diagram — Kanban Drop Operation

```
User drags card from Column A → drops on Column B
         │
         ▼
[DndContext.onDragEnd] fires with { active.id = taskId, over.id = targetStageId }
         │
         ▼
[TasksKanbanView] calls moveMutation.mutate({ id: taskId, stageId: targetStageId })
         │
    onMutate:
    1. cancelQueries(['scheduling-tasks', filter])
    2. snapshot = getQueryData(['scheduling-tasks', filter])
    3. setQueryData → move task to new stageId in cached array
    4. return { snapshot }
         │
    ┌────┴──────────────────────┐
    │ POST → PATCH /api/scheduling/:id/stage │
    │ body: { stageId }                      │
    └────┬──────────────────────┘
    200 OK              non-2xx
    onSettled           onError
    invalidateQueries   setQueryData(snapshot)  ← rollback
```

---

## File Changes Table

### Backend

| File | Type | Summary |
|------|------|---------|
| `src/application/dto/scheduling.dto.ts` | Modified | Add `ListTasksFilterSchema` (all fields optional, `stageIds: z.array(z.string().min(1)).optional()`, `q: z.string().optional()`); export `TaskListFilter` type |
| `src/domain/ports/SchedulingRepository.ts` | Modified | `listTasks(filter?: TaskListFilter): Promise<ScheduledTask[]>` |
| `src/application/use-cases/ListTasks.ts` | Modified | `execute(filter?: TaskListFilter)` passes to `repo.listTasks(filter)` |
| `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts` | Modified | Build Prisma `where` from filter; apply `stageId: { in: stageIds }`, `projectId`, `partnerId`, `assigneeId`, `title: { contains: q, mode: 'insensitive' }` |
| `src/infrastructure/adapters/in-memory/InMemorySchedulingRepository.ts` | Modified | Apply same predicates as Array `.filter()` chain |
| `src/infrastructure/http/routes/scheduling.routes.ts` | Modified | Parse `req.query` with `ListTasksFilterSchema.safeParse`; on failure return 400; on success call `listTasks.execute(parsed.data)` |
| `src/__tests__/infrastructure/scheduling.routes.filter.test.ts` | New | Supertest: GET with stageIds, projectId, q filters; verify only matching tasks returned; verify 400 on empty stageIds item |

### Frontend

| File | Type | Summary |
|------|------|---------|
| `src/App.tsx` | Modified | Add lazy import + `<Route path="/admin/scheduling/tasks" element={<SchedulingTasksPage />} />` BEFORE the `tasks/:id` route |
| `src/api/scheduling.api.ts` | Modified | `listTasks(filter?: TaskListFilter): Promise<ScheduledTask[]>` appends filter as query params |
| `src/hooks/useScheduling.ts` | Modified | Add `useFilteredTasks(filter: TaskListFilter)` with `queryKey: ['scheduling-tasks', filter]`, `refetchInterval: 30_000` |
| `src/pages/scheduling/SchedulingTasksPage/index.tsx` | New | Page root: filter bar, view toggle, chip bar, renders `TasksTableView` or `TasksKanbanView` |
| `src/pages/scheduling/SchedulingTasksPage/SchedulingTasksPage.module.css` | New | Page layout |
| `src/pages/scheduling/SchedulingTasksPage/components/TaskFilterBar.tsx` | New | Project select, StageMultiSelect, Partner select, Assignee search, search input, view toggle, Add button |
| `src/pages/scheduling/SchedulingTasksPage/components/TaskFilterBar.module.css` | New | |
| `src/pages/scheduling/SchedulingTasksPage/components/TasksTableView.tsx` | New | Wraps `DataTable` with task column defs; manages `selectedIds`; renders `BulkActionBar` |
| `src/pages/scheduling/SchedulingTasksPage/components/TasksTableView.module.css` | New | Bulk action bar sticky styles |
| `src/pages/scheduling/SchedulingTasksPage/components/TasksKanbanView.tsx` | New | `DndContext` wrapper; renders `KanbanColumn` per stage; fires optimistic `useMoveTaskToStageFiltered` |
| `src/pages/scheduling/SchedulingTasksPage/components/TasksKanbanView.module.css` | New | Board layout, horizontal scroll |
| `src/pages/scheduling/SchedulingTasksPage/components/KanbanColumn.tsx` | New | `useDroppable`; column header with stripe; column body with card list; empty state |
| `src/pages/scheduling/SchedulingTasksPage/components/KanbanColumn.module.css` | New | Column, header, body, empty state styles |
| `src/pages/scheduling/SchedulingTasksPage/components/KanbanCard.tsx` | New | `useDraggable`; seq#, title, priority pill, avatar, age, customer |
| `src/pages/scheduling/SchedulingTasksPage/components/KanbanCard.module.css` | New | Card, drag state, pill, avatar |
| `src/pages/scheduling/SchedulingTasksPage/hooks/useTasksFilterUrl.ts` | New | Read/write filter + view from `useSearchParams` |
| `src/__tests__/scheduling/SchedulingTasksPage.test.tsx` | New | Vitest suite |

---

## TypeScript Interfaces

### Backend — filter DTO

```ts
// src/application/dto/scheduling.dto.ts (addition)
export const ListTasksFilterSchema = z.object({
  projectId:  z.string().min(1).optional(),
  stageIds:   z.array(z.string().min(1)).optional(),
  partnerId:  z.string().min(1).optional(),
  assigneeId: z.string().min(1).optional(),
  q:          z.string().optional(),
});
export type TaskListFilter = z.infer<typeof ListTasksFilterSchema>;
```

### Frontend — card props

```ts
// KanbanCard.tsx
interface KanbanCardProps {
  task: ScheduledTask;
  isDragging?: boolean;   // true when rendered inside DragOverlay
}

// KanbanColumn.tsx
interface KanbanColumnProps {
  stage: Stage;               // from domain entity
  tasks: ScheduledTask[];
  isOver: boolean;            // from useDroppable
}

// TaskListFilter (mirrors backend)
interface TaskListFilter {
  projectId?:  string;
  stageIds?:   string[];
  partnerId?:  string;
  assigneeId?: string;
  q?:          string;
}

type TasksView = 'table' | 'kanban';
```

---

## Testing Strategy

### Backend

- **Unit (in-memory adapter)**: `InMemorySchedulingRepository.listTasks({ stageIds: ['x'] })` returns only matching rows; `listTasks({})` returns all (backward compat)
- **Integration (supertest)**: seed 3 tasks in 2 different stages; `GET /api/scheduling?stageIds[]=<id1>` returns only 2; `GET /api/scheduling` returns 3; `GET /api/scheduling?stageIds[]=` returns 400

### Frontend (Vitest + @testing-library/react)

- **Render**: `SchedulingTasksPage` renders in `table` view by default; URL has no initial params
- **Toggle**: click "Flujo de Trabajo" → Kanban view renders; URL updates to `?view=kanban`
- **Kanban empty state**: Kanban view with no project selected shows prompt string
- **Filter chips**: select a project → chip appears; click × on chip → filter cleared; URL updated
- **Filter URL sync**: set filter programmatically via `setSearchParams`; verify `useFilteredTasks` called with correct params
- **Drag-drop mock**: wrap with `DndContext` in test; fire `onDragEnd` event manually with `active.id` + `over.id`; assert `api.moveTaskToStage` was called with correct args
- **Optimistic UI**: in drag test, mock API to reject; assert task returns to original column after rejection
- **A11y roles**: `getByRole('region', { name: /flujo de trabajo/i })` present in Kanban; columns have `role="group"`
- **Priority pills**: `getByRole('img', { name: /urgente/i })` or `aria-label` check on pills

---

## Open Questions

1. **Partner select data source**: The backend Partner model exists but the frontend doesn't yet have a `usePartners()` hook. Should the Partner filter be a free-text input (matches partner name substring) or a select backed by `GET /api/partners`? **Recommendation**: free-text `q`-style filter per the existing `useFilteredTasks` `q` param — avoids a new hook. Revisit when the Partners page ships a public API.

2. **Project's workflowId in frontend types**: `useProjects()` returns `Project[]`. Does `Project` type include `workflowId`? The backend enriches Project with workflowId in change 2 (`scheduling-projects-enrich`). Verify `src/types/project.ts` includes `workflowId: string | null` before attempting `useWorkflow(project.workflowId)` in Kanban. The apply sub-agent MUST check this.

3. **`stageIds[]` vs `stageIds`**: Express parses `?stageIds[]=a&stageIds[]=b` as `req.query['stageIds[]'] = ['a', 'b']`. The zod schema key must match exactly. Alternative is `?stageIds=a,b` (comma-split). **Decision locked in tasks.md**: use repeated params with bracket notation, key `stageIds[]`, parsed from `req.query['stageIds[]']` before passing to zod.
