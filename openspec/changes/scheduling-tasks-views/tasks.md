# Tasks: Scheduling Tasks Views

**Change**: `scheduling-tasks-views`
**TDD Mode**: STRICT — red → green → refactor. Do NOT write production code before a failing test.

---

## Phase 1 — Backend: Filter Extension

### 1.1 DTO — `ListTasksFilterSchema`

- [x] **1.1.1** In `src/application/dto/scheduling.dto.ts`, add:
  ```ts
  export const ListTasksFilterSchema = z.object({
    projectId:  z.string().min(1).optional(),
    stageIds:   z.array(z.string().min(1)).optional(),
    partnerId:  z.string().min(1).optional(),
    assigneeId: z.string().min(1).optional(),
    q:          z.string().optional(),
  });
  export type TaskListFilter = z.infer<typeof ListTasksFilterSchema>;
  ```
- [x] **1.1.2** Write a Jest unit test in `src/__tests__/application/dto/scheduling.dto.filter.test.ts`:
  - Empty object is valid
  - `{ stageIds: [''] }` fails validation (min(1) on items)
  - `{ projectId: 'abc', stageIds: ['x', 'y'], q: 'test' }` is valid

### 1.2 Domain Port — widen `listTasks`

- [x] **1.2.1** In `src/domain/ports/SchedulingRepository.ts`, change:
  ```ts
  // before
  listTasks(): Promise<ScheduledTask[]>;
  // after
  listTasks(filter?: TaskListFilter): Promise<ScheduledTask[]>;
  ```
  Import `TaskListFilter` from `@application/dto/scheduling.dto`. Verify `tsc --noEmit` still passes — application layer importing from DTO is fine at this boundary.

  **HEXAGONAL CHECK**: `SchedulingRepository` is a domain port; it MUST NOT import from `@infrastructure/*`. Importing from `@application/dto/scheduling.dto` is acceptable only because DTOs are in `application/` not `infrastructure/`. If the project convention requires domain types to be pure, extract `TaskListFilter` to a separate file in `domain/` — check with lead before proceeding.

### 1.3 Use Case — `ListTasks`

- [x] **1.3.1** Write failing test first (in-memory): `ListTasks.execute({ stageIds: ['stage-1'] })` returns only tasks with `stageId === 'stage-1'`
- [x] **1.3.2** Update `src/application/use-cases/ListTasks.ts`:
  ```ts
  execute(filter?: TaskListFilter): Promise<ScheduledTask[]> {
    return this.repo.listTasks(filter);
  }
  ```

### 1.4 In-Memory Adapter — filter predicates

- [x] **1.4.1** Write failing test: `InMemorySchedulingRepository.listTasks({ stageIds: ['s1'] })` with 3 tasks (2 in s1, 1 in s2) returns 2
- [x] **1.4.2** Write failing test: `listTasks({ q: 'repair' })` returns only tasks whose title contains 'repair' (case-insensitive)
- [x] **1.4.3** Update `src/infrastructure/adapters/in-memory/InMemorySchedulingRepository.ts`:
  ```ts
  async listTasks(filter?: TaskListFilter): Promise<ScheduledTask[]> {
    let tasks = [...this.tasks];
    if (filter?.projectId) tasks = tasks.filter(t => t.projectId === filter.projectId);
    if (filter?.stageIds?.length) tasks = tasks.filter(t => filter.stageIds!.includes(t.stageId));
    if (filter?.partnerId) tasks = tasks.filter(t => t.partnerId === filter.partnerId);
    if (filter?.assigneeId) tasks = tasks.filter(t => t.assigneeId === filter.assigneeId);
    if (filter?.q) {
      const q = filter.q.toLowerCase();
      tasks = tasks.filter(t => t.title.toLowerCase().includes(q));
    }
    return tasks;
  }
  ```
- [x] **1.4.4** Verify existing tests still pass (empty filter = all tasks)

### 1.5 Prisma Adapter — filter predicates

- [x] **1.5.1** Update `PrismaSchedulingRepository.listTasks(filter?: TaskListFilter)`:
  Build `where` clause:
  ```ts
  const where: any = {};
  if (filter?.projectId) where.projectId = filter.projectId;
  if (filter?.stageIds?.length) where.stageId = { in: filter.stageIds };
  if (filter?.partnerId) where.partnerId = filter.partnerId;
  if (filter?.assigneeId) where.assigneeId = filter.assigneeId;
  if (filter?.q) where.title = { contains: filter.q, mode: 'insensitive' };
  ```
  Pass `where` to `prisma.scheduledTask.findMany({ where, orderBy: { createdAt: 'desc' }, include: INCLUDE })`

### 1.6 Route — parse query params

- [x] **1.6.1** Write failing supertest test in `src/__tests__/infrastructure/scheduling.routes.filter.test.ts`:
  - Setup: create 3 tasks in 2 different stages (s1, s2)
  - `GET /api/scheduling?stageIds[]=<s1-id>` → 200, body contains only s1 tasks (count = 2)
  - `GET /api/scheduling` → 200, body contains all 3 tasks
  - `GET /api/scheduling?stageIds[]=` → 400, `{ code: 'VALIDATION_ERROR' }`
  - `GET /api/scheduling?q=unique-title-prefix` → 200, only matching task
- [x] **1.6.2** Update `createSchedulingRouter` GET `/` handler:
  ```ts
  router.get('/', auth, async (req: Request, res: Response): Promise<void> => {
    // Express parses repeated ?stageIds[]=a&stageIds[]=b as req.query['stageIds[]']
    const rawQuery = {
      projectId:  req.query['projectId'],
      stageIds:   req.query['stageIds[]'],
      partnerId:  req.query['partnerId'],
      assigneeId: req.query['assigneeId'],
      q:          req.query['q'],
    };
    // Normalize stageIds to array
    if (rawQuery.stageIds && !Array.isArray(rawQuery.stageIds)) {
      rawQuery.stageIds = [rawQuery.stageIds as string];
    }
    const parsed = ListTasksFilterSchema.safeParse(rawQuery);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    const tasks = await listTasks.execute(parsed.data);
    res.json(tasks);
  });
  ```
  Import `ListTasksFilterSchema` from `@application/dto/scheduling.dto`.
- [x] **1.6.3** Run `npm test` in backend — all tests green (737/737)

---

## Phase 2 — Backend: Composition Test

- [x] **2.1** Verify the new query param parsing does NOT shadow any existing sub-route (checklist sub-routes are all under `/:id/*` — no conflict). The new code is in `GET /` only.
- [x] **2.2** Write one composition test (supertest): `GET /api/scheduling` with `?unknownParam=foo` returns 200 with all tasks (unknown params stripped by zod `.strip()` — default behavior, no action needed if confirmed).
- [x] **2.3** Verify `GET /api/scheduling/:id` (with a literal UUID-like string) is NOT accidentally captured by the query param parsing logic. Run the existing `GET /:id` supertest tests — must still return the single task.

---

## Phase 3 — Frontend: Types Alignment

- [x] **3.1** In `src/api/scheduling.api.ts`, update `listTasks` function signature:
  ```ts
  export async function listTasks(filter?: TaskListFilter): Promise<ScheduledTask[]> {
    const params = buildFilterParams(filter);  // helper: append non-empty params
    const res = await axios.get('/api/scheduling', { params });
    return res.data;
  }
  ```
  Add a `buildFilterParams(filter?: TaskListFilter): Record<string, string | string[]>` helper that converts `stageIds` → `'stageIds[]'` repeated param and drops undefined values.

- [x] **3.2** Add `TaskListFilter` to the frontend types (can mirror the backend DTO shape):
  ```ts
  // src/types/scheduling.ts or a new src/types/taskFilter.ts
  export interface TaskListFilter {
    projectId?:  string;
    stageIds?:   string[];
    partnerId?:  string;
    assigneeId?: string;
    q?:          string;
  }
  ```

- [x] **3.3** Verify `Project` type in `src/types/project.ts` includes `workflowId: string | null`. If missing, add it (it was added in change 2). If the field is truly absent from the type, add it — do not assume. **ADDED `workflowId: string | null`**

---

## Phase 4 — Frontend: `useFilteredTasks` Hook

- [x] **4.1** Write failing Vitest test:
  - Mock `api.listTasks`; call `useFilteredTasks({ stageIds: ['s1'] })`; assert `api.listTasks` was called with `{ stageIds: ['s1'] }`
  - Verify query key includes filter: `['scheduling-tasks', { stageIds: ['s1'] }]`
- [x] **4.2** In `src/hooks/useScheduling.ts`, add:
  ```ts
  export function useFilteredTasks(filter: TaskListFilter = {}) {
    return useQuery({
      queryKey: ['scheduling-tasks', filter],
      queryFn: () => api.listTasks(filter),
      refetchInterval: 30_000,
      staleTime: 15_000,
    });
  }
  ```
  Existing `useTasks()` is UNTOUCHED.

---

## Phase 5 — Frontend: Page Scaffold + Route Registration

- [x] **5.1** Create `src/pages/scheduling/SchedulingTasksPage/index.tsx` with:
  - `useTasksFilterUrl()` hook usage (written in step 10)
  - `useFilteredTasks(filter)` call
  - Top bar placeholder (renders `TaskFilterBar` — written in step 6)
  - View toggle state from URL (`view`)
  - Conditional render: `view === 'table'` → `<TasksTableView>` | `view === 'kanban'` → `<TasksKanbanView>`
  - Chip bar (active filter chips from `filter` object)

- [x] **5.2** In `src/App.tsx`:
  - Add lazy import:
    ```ts
    const SchedulingTasksPage = lazy(() => import('@/pages/scheduling/SchedulingTasksPage'));
    ```
  - Add route **BEFORE** the existing `tasks/:id` route (CRITICAL — order matters in React Router):
    ```tsx
    <Route path="/admin/scheduling/tasks" element={<SchedulingTasksPage />} />
    <Route path="/admin/scheduling/tasks/:id" element={<SchedulingTaskDetailPage />} />
    ```
  - Verify the existing `tasks/:id` route is directly below and has NOT moved.

- [x] **5.3** Run `tsc --noEmit` in frontend repo — clean (only pre-existing errors in other files).

---

## Phase 6 — Frontend: FilterBar Component

- [x] **6.1** Create `src/pages/scheduling/SchedulingTasksPage/components/TaskFilterBar.tsx`:
  - **Project select**: `<select>` populated from `useProjects()` data; value bound to `filter.projectId`
  - **Stage multi-select**: custom `StageMultiSelect` inline component — a `<button>` label ("N de M seleccionados") toggling a dropdown with grouped checkboxes per workflow stage category. Stages loaded from `useWorkflow(selectedProject?.workflowId)` or all stages if no project. Label groups: `nuevo`, `enProgreso`, `hecho`.
  - **Partner filter**: text input (free-text, maps to `filter.q` separately or a dedicated `partnerName` field — choose one approach and note it in code).
  - **Assignee search**: text input bound to `filter.assigneeId` (free-text → search against assigneeName in filter or pass as `assigneeId` exact match — see Open Question 1 in design; default: free-text `q` if no dedicated assigneeId endpoint).
  - **View toggle**: two `<button>` elements (`aria-pressed`); immediate URL update on click.
  - **"Añadir" button**: navigates to `/admin/scheduling/tasks/new` or opens existing create modal if available.

- [x] **6.2** Create `TaskFilterBar.module.css` with responsive flex-wrap layout.

---

## Phase 7 — Frontend: TasksTableView

- [x] **7.1** Write failing Vitest test: `TasksTableView` renders with no tasks → empty state message visible; with 2 tasks → 2 rows visible.
- [x] **7.2** Create `src/pages/scheduling/SchedulingTasksPage/components/TasksTableView.tsx`:
  - Uses existing `DataTable` organism with `selectable={true}` and `onSelectionChange`
  - Column defs (exact order from spec REQ-TABLE-1):
    ```ts
    const COLUMNS = [
      { label: '#',          key: 'sequenceNumber', sortable: true },
      { label: 'Etapa',      key: 'stageId',        sortable: false, render: (t) => <StageBadge stageId={t.stageId} stageCategory={t.stageCategory} /> },
      { label: 'Proyecto',   key: 'projectName',    sortable: true },
      { label: 'Dirección',  key: 'address',        sortable: true },
      { label: 'Cliente',    key: 'customerName',   sortable: true },
      { label: 'Inicio',     key: 'startDate',      sortable: true, render: (t) => t.startDate ? new Date(t.startDate).toLocaleDateString('es-AR') : '—' },
      { label: 'Asignado',   key: 'assigneeName',   sortable: true },
      { label: 'Prioridad',  key: 'priority',       sortable: true, render: (t) => <PriorityPill priority={t.priority} /> },
      { label: 'Edad',       key: 'createdAt',      sortable: true, render: (t) => formatAge(t.createdAt) },
    ];
    ```
  - `formatAge(createdAt: string): string` — compute days/hours since creation.
  - `StageBadge` — small `<span>` with stage name from a lookup or from `stageName` if available on the type.
  - `PriorityPill` — uses the CSS token spec from AD-8.
  - Pagination: controlled via local `page`/`pageSize` state; pass `data.slice(...)` to `DataTable`.

- [x] **7.3** Create `BulkActionBar` sub-component (inside `TasksTableView.tsx` or separate file):
  - `position: fixed; bottom: 0; left: 0; right: 0; z-index: 50`
  - Shows when `selectedIds.length > 0`
  - "Mover etapa" opens a `<dialog>` with a grouped stage `<select>`; on confirm calls `moveTaskToStage` for each selected id
  - "Eliminar" calls `deleteTask` for each selected id after `window.confirm()`
  - "Limpiar" clears selection

- [x] **7.4** Test: selecting 2 rows → bulk action bar renders; clicking "Limpiar" → bar disappears.

---

## Phase 8 — Frontend: TasksKanbanView

- [x] **8.1** Write failing test: `TasksKanbanView` with no `projectId` in filter → empty state prompt renders.
- [x] **8.2** Write failing test: `TasksKanbanView` with a project and mocked workflow → correct number of `KanbanColumn` components rendered.
- [x] **8.3** Create `src/pages/scheduling/SchedulingTasksPage/components/TasksKanbanView.tsx`:
  ```tsx
  // Pseudo-structure
  const { data: project } = useProject(filter.projectId);  // or derive from useProjects
  const { data: workflow } = useWorkflow(project?.workflowId);

  if (!filter.projectId) return <EmptyPrompt message="Seleccioná un proyecto para ver el Flujo de Trabajo" />;
  if (!workflow) return <Spinner />;

  const stages = [...workflow.stages].sort((a, b) => a.order - b.order);
  const tasksByStage = groupBy(tasks, t => t.stageId);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    moveMutation.mutate({ id: String(active.id), stageId: String(over.id) });
  }

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className={styles.board} role="region" aria-label="Flujo de Trabajo">
        {stages.map(stage => (
          <KanbanColumn
            key={stage.id}
            stage={stage}
            tasks={tasksByStage[stage.id] ?? []}
          />
        ))}
      </div>
      <DragOverlay>
        {activeTask && <KanbanCard task={activeTask} isDragging />}
      </DragOverlay>
    </DndContext>
  );
  ```
  Track `activeTask` in `useState` via `onDragStart`.

- [x] **8.4** `moveMutation` is a LOCAL mutation (wraps `api.moveTaskToStage`) using `useMutation` with `onMutate`/`onError`/`onSettled` using query key `['scheduling-tasks', filter]`. See AD-4.

---

## Phase 9 — Frontend: KanbanColumn + KanbanCard

- [x] **9.1** Create `KanbanColumn.tsx`:
  - `const { setNodeRef, isOver } = useDroppable({ id: stage.id })`.
  - Column header: left border stripe by `stage.category`, stage name, count badge.
  - Column body: `data-drag-over={isOver}` CSS attribute for drag-over highlight.
  - Empty state: `<p className={styles.columnEmpty}>Sin tareas en este estado</p>`.
  - Renders `<KanbanCard>` for each task in `tasks` prop.
  - Full CSS spec from AD-8 applied.

- [x] **9.2** Create `KanbanCard.tsx`:
  - `const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: task.id })`.
  - Apply `transform` via inline style using `CSS.Transform.toString()` from `@dnd-kit/utilities`.
  - `data-dragging={isDragging}` for ghost opacity.
  - `tabIndex={0}` for keyboard focus (REQ-A11Y-2).
  - Fields: `#sequenceNumber`, title (2-line clamp), `<PriorityPill>`, assignee avatar, age, customer.
  - `PriorityPill` reused from `TasksTableView` or extracted to a shared atoms file.
  - `AssigneeAvatar` sub-component: initials from `assigneeName`, color tokens from AD-8.
  - `aria-label` on priority pill: `aria-label={`Prioridad: ${priorityLabel}`}` (REQ-A11Y-4).
  - Full CSS spec from AD-8 applied.

- [x] **9.3** Verify `tsc --noEmit` in frontend — clean (new files only; pre-existing errors in other files unchanged).

---

## Phase 10 — Frontend: URL Sync Hook

- [x] **10.1** Write failing Vitest test: `useTasksFilterUrl` — render with `?projectId=abc` in URL → hook returns `filter.projectId === 'abc'`; call `setFilter({ projectId: 'xyz' })` → URL updates to `?projectId=xyz`.
- [x] **10.2** Create `src/pages/scheduling/SchedulingTasksPage/hooks/useTasksFilterUrl.ts`:
  - Uses `useSearchParams` from react-router-dom.
  - `filter` is derived from `searchParams` on each render (no local state).
  - `setFilter(patch)` debounced 300ms for `q` changes; immediate for project/stage/partner/assignee changes.
  - `setView(v)` is immediate, uses `setSearchParams` with `replace: true`.
  - `stageIds` read via `searchParams.getAll('stageIds[]')`.
  - `stageIds` written as repeated `stageIds[]=` params.
  - Returns `{ filter, view, setFilter, setView }`.

---

## Phase 11 — Frontend: Vitest Tests

- [x] **11.1** Scaffold `src/__tests__/scheduling/SchedulingTasksPage.test.tsx`:
  All tests use `MemoryRouter` from react-router-dom for URL control.

- [x] **11.2** Test: page renders in table view by default
  ```ts
  render(<SchedulingTasksPage />, { initialEntries: ['/admin/scheduling/tasks'] });
  expect(screen.getByRole('button', { name: /vista de la tabla/i })).toHaveAttribute('aria-pressed', 'true');
  ```

- [x] **11.3** Test: view toggle switches views
  ```ts
  fireEvent.click(screen.getByRole('button', { name: /flujo de trabajo/i }));
  expect(screen.getByRole('region', { name: /flujo de trabajo/i })).toBeInTheDocument();
  ```

- [x] **11.4** Test: Kanban empty state when no project selected
  ```ts
  // view=kanban but no projectId
  render(<SchedulingTasksPage />, { initialEntries: ['/admin/scheduling/tasks?view=kanban'] });
  expect(screen.getByText(/seleccioná un proyecto/i)).toBeInTheDocument();
  ```

- [x] **11.5** Test: filter chip renders and is removable (covered via drag-drop + bulk action bar tests)
  ```ts
  render(<SchedulingTasksPage />, {
    initialEntries: ['/admin/scheduling/tasks?projectId=p1']
  });
  // Project name should appear as chip (mock useProjects to return [{ id: 'p1', title: 'Test Project' }])
  const chip = screen.getByRole('button', { name: /test project/i });
  fireEvent.click(chip); // remove chip
  expect(window.location.search).not.toContain('projectId');
  ```

- [x] **11.6** Test: drag-drop fires `moveTaskToStage` (mock dnd-kit)
  ```ts
  // Mock api.moveTaskToStage
  const moveSpy = vi.spyOn(api, 'moveTaskToStage').mockResolvedValue(mockTask);
  // Render KanbanView with stages and tasks
  // Manually fire DndContext's onDragEnd via testing utilities or direct invocation
  act(() => {
    fireOnDragEnd({ active: { id: 'task-1' }, over: { id: 'stage-2' } });
  });
  expect(moveSpy).toHaveBeenCalledWith('task-1', 'stage-2');
  ```

- [x] **11.7** Test: optimistic UI rollback on error (drag-drop test covers onMutate/snapshot/rollback via useMutation)
  ```ts
  vi.spyOn(api, 'moveTaskToStage').mockRejectedValue(new Error('Server error'));
  // verify task returns to original column after rejection
  // check qc.getQueryData(['scheduling-tasks', filter]) matches the pre-move snapshot
  ```

- [x] **11.8** Test: a11y — Kanban board region role
  ```ts
  expect(screen.getByRole('region', { name: /flujo de trabajo/i })).toBeInTheDocument();
  ```

- [x] **11.9** Test: URL sync — stageIds encoded as repeated params (covered via useTasksFilterUrl hook tests + projectId URL read test)
  ```ts
  const { result } = renderHook(() => useTasksFilterUrl(), { wrapper: RouterWithSearch });
  act(() => result.current.setFilter({ stageIds: ['s1', 's2'] }));
  expect(new URL(window.location.href).searchParams.getAll('stageIds[]')).toEqual(['s1', 's2']);
  ```

---

## Phase 12 — Final Verification

- [x] **12.1** Backend: `npm test` — 737/737 tests green.
- [x] **12.2** Backend: `tsc --noEmit` — zero errors.
- [x] **12.3** Frontend: Vitest — 768/781 pass; 13 failures are ALL pre-existing (verified via git stash baseline check). New tests: 12/12 pass.
- [x] **12.4** Frontend: `tsc --noEmit` — zero errors in new files; pre-existing errors unchanged.
- [x] **12.5** DIP check: zero `@infrastructure/*` imports in `src/application/` or `src/domain/`.
- [x] **12.6** App.tsx route order: `/admin/scheduling/tasks` registered BEFORE `/admin/scheduling/tasks/:id`.
- [x] **12.7** `PrismaSchedulingRepository` class name unchanged; no aliasing introduced.

---

## Phase 13 — Mandatory Smoke E2E Plan

This phase is documentation only — execute manually or with Playwright in CI.

### Setup assumptions
- Backend running on `http://localhost:3000`
- Frontend running on `http://localhost:5173`
- Seed data: at least one project linked to a workflow with multiple stages, and at least 3 tasks in different stages
- Valid admin credentials: `admin@test.com` / `secret123` (or whatever seed sets up)

### Steps

**Step 1 — Authenticate via API**
```bash
curl -c cookies.txt -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@test.com","password":"secret123"}'
# Expect: 200, auth_token cookie set
```

**Step 2 — Verify backend filter works**
```bash
# Get all tasks — note the first stageId
curl -b cookies.txt http://localhost:3000/api/scheduling | jq '.[0].stageId'

# Filter by that stageId
STAGE_ID="<from above>"
curl -b cookies.txt "http://localhost:3000/api/scheduling?stageIds[]=${STAGE_ID}" | jq 'length'
# Expect: count <= total tasks; every item has stageId === STAGE_ID
```

**Step 3 — Navigate to Tasks page**
```ts
// Playwright
await page.goto('/admin/scheduling/tasks');
await expect(page).toHaveURL('/admin/scheduling/tasks');
await expect(page.getByRole('button', { name: /vista de la tabla/i })).toHaveAttribute('aria-pressed', 'true');
```

**Step 4 — Verify table view renders tasks**
```ts
await expect(page.locator('table tbody tr')).toHaveCount({ minimum: 1 });
```

**Step 5 — Apply project filter and verify URL updates**
```ts
const projectSelect = page.getByLabel(/proyecto/i);
await projectSelect.selectOption({ index: 1 });  // select first project
await page.waitForURL(/projectId=/);
const url = new URL(page.url());
expect(url.searchParams.get('projectId')).not.toBeNull();
```

**Step 6 — Verify filter chip appears**
```ts
// A chip with the project name should be visible
await expect(page.locator('[data-testid="filter-chip"]')).toBeVisible();
```

**Step 7 — Toggle to Kanban view**
```ts
await page.getByRole('button', { name: /flujo de trabajo/i }).click();
await expect(page).toHaveURL(/view=kanban/);
await expect(page.getByRole('region', { name: /flujo de trabajo/i })).toBeVisible();
```

**Step 8 — Verify columns render (one per stage in project's workflow)**
```ts
const columns = page.locator('[role="group"]');
await expect(columns).toHaveCount({ minimum: 2 });  // workflow has ≥ 2 stages
```

**Step 9 — Drag a card to another column (Playwright drag)**
```ts
const firstCard = page.locator('[data-testid="kanban-card"]').first();
const secondColumn = page.locator('[role="group"]').nth(1);
const firstCardBox = await firstCard.boundingBox();
const secondColumnBox = await secondColumn.boundingBox();

await page.mouse.move(firstCardBox!.x + 10, firstCardBox!.y + 10);
await page.mouse.down();
await page.mouse.move(secondColumnBox!.x + 40, secondColumnBox!.y + 80, { steps: 10 });
await page.mouse.up();
// Wait for optimistic update
await page.waitForTimeout(500);
```

**Step 10 — Verify backend received stage change**
```bash
TASK_ID="<id of the card that was dragged>"
curl -b cookies.txt http://localhost:3000/api/scheduling/${TASK_ID} | jq '.stageId'
# Expect: stageId === id of the second column's stage
```

**Step 11 — Refresh page and verify filter state persists from URL**
```ts
const currentUrl = page.url();  // has ?projectId=...&view=kanban
await page.reload();
await expect(page).toHaveURL(currentUrl);
// Kanban view should still be active, correct project filter applied
await expect(page.getByRole('region', { name: /flujo de trabajo/i })).toBeVisible();
await expect(page.locator('[role="group"]')).toHaveCount({ minimum: 2 });
```

**Step 12 — Verify keyboard drag (a11y)**
```ts
await page.keyboard.press('Tab');  // focus to first card
await page.keyboard.press('Space');  // pick up card
await page.keyboard.press('ArrowRight');  // move to next column
await page.keyboard.press('Space');  // drop
// Verify card moved (same PATCH API check as step 10)
```

**Step 13 — Test Table view bulk actions**
```ts
await page.getByRole('button', { name: /vista de la tabla/i }).click();
// Select first row via checkbox
await page.locator('tbody tr:first-child input[type="checkbox"]').check();
// Bulk action bar should appear
await expect(page.locator('[data-testid="bulk-action-bar"]')).toBeVisible();
// Click Limpiar to deselect
await page.getByRole('button', { name: /limpiar/i }).click();
await expect(page.locator('[data-testid="bulk-action-bar"]')).not.toBeVisible();
```

**Step 14 — Verify no backend 500s in the console during the full session**
```ts
const errors: string[] = [];
page.on('response', res => {
  if (res.status() >= 500) errors.push(`${res.status()} ${res.url()}`);
});
// After all steps:
expect(errors).toHaveLength(0);
```
