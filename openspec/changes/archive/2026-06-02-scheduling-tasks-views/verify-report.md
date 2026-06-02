# Verify Report — scheduling-tasks-views

**Date**: 2026-05-20
**Reviewer**: Adversarial verify agent

---

## Summary

- **Backend tests**: green, 737/737 total
- **Backend typecheck**: clean (zero errors)
- **Frontend tests (new)**: green, 12/12 in SchedulingTasksPage.test.tsx
- **Frontend tests (overall)**: 768/781 pass; 13 failures ALL pre-existing (confirmed via git stash baseline — same 5 files failed before this change)
- **Frontend typecheck (new files)**: clean in new files; pre-existing errors unchanged (same files as before)
- **Hexagonal boundary**: preserved — zero `@infrastructure` imports in `src/application/` or `src/domain/`
- **Route order in App.tsx**: verified — `/admin/scheduling/tasks` (line 214) registered BEFORE `/admin/scheduling/tasks/:id` (line 215)
- **Optimistic queryKey alignment**: verified — `moveMutation` in `TasksKanbanView` uses `['scheduling-tasks', filter]` matching `useFilteredTasks(filter)`'s queryKey exactly
- **Express stageIds parse**: verified correct — route reads `req.query['stageIds']`; axios sends `{'stageIds[]': [...]}` which qs decodes to `req.query.stageIds`; both paths consistent
- **dangerouslySetInnerHTML**: none found

---

## CRITICAL findings (block commit)

### CRITICAL-1 — BulkActionBar missing "Mover etapa" button (REQ-TABLE-5 + REQ-TABLE-6 violated)

**File**: `src/pages/scheduling/SchedulingTasksPage/components/TasksTableView.tsx:72-85` and `:164`

**Evidence**:
- `BulkActionBar` renders only "Eliminar" and "✕ Limpiar" — no "Mover etapa" button
- `onMoveStage` prop is passed as `(_ids, _stageId) => { /* TODO: implement move stage modal */ }` (line 164) — explicit TODO stub

**Spec violation**:
- REQ-TABLE-5: "it MUST offer two actions: 'Mover etapa' and 'Eliminar'"
- REQ-TABLE-6: "a modal MUST open with a `<select>` listing all available stages; confirming MUST call `PATCH /api/scheduling/:id/stage` for each selected task"

**Severity**: CRITICAL — the spec mandates both actions. "Mover etapa" is missing entirely from the rendered UI. The delete action is also a stub (`onDelete={(_ids) => { /* TODO: call delete mutations */ }}`).

**Fix**: implement the `BulkActionBar` with a `<dialog>` stage select for "Mover etapa" and wire `useMoveTaskToStage` per AD-7. Also wire `useDeleteTask` per the TODO comment.

---

## WARNING findings

### WARNING-1 — `createdAt` not in `ScheduledTask` type; two unsafe casts present

**Files**:
- `src/pages/scheduling/SchedulingTasksPage/components/TasksTableView.tsx:118`
- `src/pages/scheduling/SchedulingTasksPage/components/KanbanColumn.tsx:38`
- `src/pages/scheduling/SchedulingTasksPage/components/KanbanCard.tsx:51`

**Evidence**: Three uses of `(task as unknown as Record<string, string>)['createdAt']`. The `ScheduledTask` interface in `src/types/scheduling.ts` lacks `createdAt`. The backend DOES return `createdAt` (it's in the Prisma model). REQ-KANBAN-6 requires ordering by `createdAt` descending — this currently works at runtime only because the field happens to exist in the JSON, but TypeScript cannot verify it.

**Fix**: Add `createdAt: string` to the `ScheduledTask` interface in `src/types/scheduling.ts`, remove all three casts. This aligns the type with what the backend actually sends.

### WARNING-2 — Partner filter and Assignee filter missing from `TaskFilterBar`

**File**: `src/pages/scheduling/SchedulingTasksPage/components/TaskFilterBar.tsx`

**Evidence**: `TaskFilterBar` has: Project select, StageMultiSelect, search input `q`, view toggle, Add button. Missing: Partner filter (free-text per design AD-9 Open Question 1) and Assignee search input.

**Spec**: Design AD-9 shows `[ Socios ▾ ] [ Asignado: search ]` as required filter controls. Backend already supports `partnerId` (REQ-FILTER-3) and `assigneeId` (REQ-FILTER-4) filtering. The frontend filter bar does not expose them.

**Severity**: WARNING. The backend supports these filters and the spec lists them, but they are UI-only gaps — filtering still works via URL params if typed manually. Defer to a follow-up if scope is intentionally limited, but document it.

### WARNING-3 — URL sync debounce is external to `useTasksFilterUrl`

**File**: `src/pages/scheduling/SchedulingTasksPage/hooks/useTasksFilterUrl.ts:37`

**Comment in code**: "setFilter merges a patch; setView is immediate. Text inputs should debounce calls to setFilter externally (300ms) before calling."

**Design spec**: AD-10 says debounce 300ms should be in `useTasksFilterUrl`'s `setFilter`. The hook exports a plain non-debounced `setFilter`. The debounce IS implemented in `TaskFilterBar.tsx:108-119` (local ref + setTimeout for the `q` input), but:
1. Only `q` is debounced; other inputs (partner, assignee) would not be debounced if added
2. The contract is inverted — callers must know to debounce
3. `useTasksFilterUrl` tests (task 10.1) test immediate setFilter — not debounced behavior

**Severity**: WARNING. Current behavior meets AD-10 for `q` (the only text input today), but the architecture deviates from the spec and will bite when partner/assignee text inputs are added.

### WARNING-4 — URL hook `setFilter` uses `new URLSearchParams()` losing view param on clear-then-set

**File**: `src/pages/scheduling/SchedulingTasksPage/hooks/useTasksFilterUrl.ts:41-68`

`setFilter` always starts from a fresh `new URLSearchParams()` and manually preserves `view`. If new filter keys are added to the URL (e.g. page number), they would be silently dropped. Comparison: `setView` correctly uses the functional `prev => { prev.set(...); return prev; }` pattern which is safer. Low impact now, but worth noting.

### WARNING-5 — `stageIds` read vs written inconsistency in URL hook (cosmetic but real)

**File**: `src/pages/scheduling/SchedulingTasksPage/hooks/useTasksFilterUrl.ts`

- **Write**: `merged.stageIds.forEach(id => next.append('stageIds[]', id))` — writes `stageIds[]` key
- **Read**: `searchParams.getAll('stageIds[]')` — reads `stageIds[]` key

This is internally consistent. BUT: the URL visible in the browser will have `stageIds%5B%5D=a` (percent-encoded brackets). Some users/tools copy-paste the raw URL and try to edit it — the bracket encoding can be confusing. This is a UX cosmetic, not a bug.

### WARNING-6 — `BulkActionBar` delete action is also a stub

**File**: `src/pages/scheduling/SchedulingTasksPage/components/TasksTableView.tsx:165`

```ts
onDelete={(_ids) => { /* TODO: call delete mutations */ }}
```

The `window.confirm` fires correctly (line 67) but `onDelete` does nothing. Deletes silently fail. Covered together with CRITICAL-1.

---

## SUGGESTION findings

### SUGGESTION-1 — Add `createdAt` sort fallback for tasks without the field

In `KanbanColumn.tsx:38`, if `createdAt` is `undefined` (pre-existing tasks without the field), `new Date(undefined)` returns `NaN`, which breaks sort ordering silently. The fallback `?? 0` handles this, but once `createdAt: string` is added to the type (WARNING-1 fix), the fallback can be `?? ''` with proper typed access.

### SUGGESTION-2 — `stageIds` empty array written to URL as nothing

When `filter.stageIds = []`, the URL sync skips appending any `stageIds[]` params. This is correct behavior (all stages). But when reading, `searchParams.getAll('stageIds[]')` returns `[]` for no params — consistent. No bug, just document that empty array = no filter (not "zero stages selected").

### SUGGESTION-3 — `KanbanCard` uses `isDragging` from `useDraggable` AND from props

`KanbanCard` receives `isDragging?: boolean` prop (for `DragOverlay` rendering) AND calls `useDraggable` which returns `isDragging: isSelfDragging`. Ghost opacity logic: `isGhost = isSelfDragging && !isDragging`. When rendered inside `DragOverlay`, the prop `isDragging=true` suppresses ghost opacity — correct. But inside `DragOverlay`, `useDraggable` is called again with the same `task.id`, potentially causing a dnd-kit warning about duplicate draggable IDs. Verify this doesn't trigger a console error in production.

---

## Spec REQ Coverage Matrix

| REQ-ID | Status | Test File | Implementation File |
|--------|--------|-----------|---------------------|
| REQ-FILTER-1 | ✅ | `scheduling.routes.filter.test.ts` | `PrismaSchedulingRepository.ts`, `InMemorySchedulingRepository.ts` |
| REQ-FILTER-2 | ✅ | `scheduling.routes.filter.test.ts` | Route + repo |
| REQ-FILTER-3 | ✅ | `scheduling.routes.filter.test.ts` | Route + repo |
| REQ-FILTER-4 | ✅ | `scheduling.routes.filter.test.ts` | Route + repo |
| REQ-FILTER-5 | ✅ | `scheduling.routes.filter.test.ts` | Route + repo |
| REQ-FILTER-6 | ✅ | `scheduling.routes.filter.test.ts` | Route + repo |
| REQ-FILTER-7 | ✅ | `scheduling.routes.filter.test.ts` | Route + repo |
| REQ-LIST-FILTER-VAL-1 | ✅ | `scheduling.routes.filter.test.ts` | `scheduling.dto.ts` zod schema |
| REQ-LIST-FILTER-VAL-2 | ✅ | `scheduling.routes.filter.test.ts` | zod `.strip()` default |
| REQ-LIST-FILTER-VAL-3 | ✅ | `scheduling.dto.filter.test.ts` | `z.string().min(1)` not `.uuid()` |
| REQ-PAGE-1 | ✅ | `SchedulingTasksPage.test.tsx` | `App.tsx` route + `index.tsx` |
| REQ-PAGE-2 | ✅ | `SchedulingTasksPage.test.tsx` | `useTasksFilterUrl` default `'table'` |
| REQ-PAGE-3 | ✅ | `SchedulingTasksPage.test.tsx` | View toggle buttons + URL update |
| REQ-PAGE-4 | ✅ | `SchedulingTasksPage.test.tsx` | `useTasksFilterUrl` reads URL on init |
| REQ-TABLE-1 | ⚠️ | `SchedulingTasksPage.test.tsx` (partial) | `TasksTableView.tsx` COLUMNS — "Seq# / Stage / Project / Dirección / Cliente / Inicio / Asignado / Prioridad / Edad / Acciones" present but column label for "Fecha inicio" is "Inicio" (acceptable) |
| REQ-TABLE-2 | ✅ | DataTable organism handles sort | `DataTable` with `sortable: true` cols |
| REQ-TABLE-3 | ✅ | `SchedulingTasksPage.test.tsx` | Pagination in `TasksTableView` |
| REQ-TABLE-4 | ✅ | `SchedulingTasksPage.test.tsx` | `selectable={true}` on DataTable |
| REQ-TABLE-5 | ❌ **CRITICAL** | Missing | `BulkActionBar` lacks "Mover etapa" button |
| REQ-TABLE-6 | ❌ **CRITICAL** | Missing | Move stage modal is a TODO stub |
| REQ-TABLE-7 | ✅ | `SchedulingTasksPage.test.tsx` | `Ver detalle` ACTIONS entry |
| REQ-KANBAN-1 | ✅ | `SchedulingTasksPage.test.tsx` | `TasksKanbanView` empty state check |
| REQ-KANBAN-2 | ✅ | `SchedulingTasksPage.test.tsx` | Column render per workflow.stages sorted by order |
| REQ-KANBAN-3 | ✅ | `SchedulingTasksPage.test.tsx` | KanbanCard fields: seq, title, priority pill, avatar, age, customer |
| REQ-KANBAN-4 | ✅ | `SchedulingTasksPage.test.tsx` | dnd-kit `onDragEnd` → `moveMutation.mutate` |
| REQ-KANBAN-5 | ✅ | `SchedulingTasksPage.test.tsx` | `onError` restores snapshot |
| REQ-KANBAN-6 | ✅ (runtime) | — | `KanbanColumn` sort by `createdAt` desc (WARNING-1: unsafe cast) |
| REQ-KANBAN-7 | ✅ | — | `columnEmpty` text "Sin tareas en este estado" |
| REQ-URL-SYNC-1 | ⚠️ | `SchedulingTasksPage.test.tsx` (partial) | 300ms debounce for `q` only, external to hook (WARNING-3) |
| REQ-URL-SYNC-2 | ✅ | `SchedulingTasksPage.test.tsx` | `setView` is immediate |
| REQ-URL-SYNC-3 | ✅ | `SchedulingTasksPage.test.tsx` | URL params read on init |
| REQ-URL-SYNC-4 | ✅ | `SchedulingTasksPage.test.tsx` | `stageIds[]` bracket notation read/write |
| REQ-A11Y-1 | ✅ | `SchedulingTasksPage.test.tsx` | `role="region"` + `aria-label="Flujo de Trabajo"` on board; `role="group"` on columns |
| REQ-A11Y-2 | ✅ | — | `tabIndex={0}` on cards; `aria-grabbed` managed by dnd-kit |
| REQ-A11Y-3 | ✅ | — | Both `PointerSensor` + `KeyboardSensor` registered |
| REQ-A11Y-4 | ✅ | — | `aria-label={Prioridad: ${label}}` on PriorityPill |
| REQ-A11Y-5 | ✅ | `SchedulingTasksPage.test.tsx` | `aria-pressed` on view toggle buttons |
| REQ-RESPONSIVE-1 | ✅ | — | `overflow-x: auto` on `.board`, `min-width: 240px` on `.column` |
| REQ-RESPONSIVE-2 | ✅ | — | Table has `overflow-x: auto` via wrapper |
| REQ-RESPONSIVE-3 | ✅ | — | `flex-wrap: wrap` on `.controls` in `TaskFilterBar.module.css` |

---

## AD-8 Visual Tokens Check

| Token | Spec | Actual | Status |
|-------|------|--------|--------|
| Column width | 280px fixed | `flex: 0 0 280px` ✅ | ✅ |
| Column gap | 16px | `gap: 16px` in `.board` | ✅ |
| Header stripe nuevo | `#93aec8` | `--kanban-nuevo-stripe: #93aec8` | ✅ |
| Header stripe enProgreso | `#d97706` | `--kanban-en-progreso-stripe: #d97706` | ✅ |
| Header stripe hecho | `#16a34a` | `--kanban-hecho-stripe: #16a34a` | ✅ |
| Card padding | 12px | `padding: 12px` | ✅ |
| Card title | 14/600, 2-line clamp | `font-size: 14px; font-weight: 600; -webkit-line-clamp: 2` | ✅ |
| Priority pill low | `#f3f4f6` / `#374151` | Matched | ✅ |
| Priority pill urgent | `#fee2e2` / `#991b1b` | Matched | ✅ |
| Drag-over bg | sky-50 `#f0f9ff` | `background: #f0f9ff` | ✅ |
| Drag-over outline | `2px dashed #0ea5e9` | Matched | ✅ |
| Column body max-height | `calc(100vh - 280px)` | Matched | ✅ |

All AD-8 tokens implemented correctly.

---

## Hexagonal Boundary Check

```
grep -r "@infrastructure" src/application/ src/domain/  → 0 results ✅
grep -r "dangerouslySetInnerHTML" src/pages/scheduling/SchedulingTasksPage/ → 0 results ✅
```

---

## Open Items Deferred to Future

1. **Partner / Assignee filter UI** (WARNING-2): implement `partnerId` and `assigneeId` text inputs in `TaskFilterBar`. Backend already supports these. Defer to next iteration.
2. **URL hook debounce internalization** (WARNING-3): move 300ms debounce into `useTasksFilterUrl.setFilter` for robustness. Low risk for now.
3. **E2E smoke test** (Phase 13 in tasks.md): manual Playwright test plan documented but not automated. Execute manually before production deploy.

---

## Recommendation

**FIX-CRITICAL-FIRST**

Two spec violations block commit:

1. **`BulkActionBar` "Mover etapa" button missing** — REQ-TABLE-5 + REQ-TABLE-6 are fully unimplemented. The button must render and open a `<dialog>` stage selector wired to `useMoveTaskToStage`.
2. **Delete action in BulkActionBar is a stub** — `onDelete` fires `window.confirm` but does nothing on confirm. Wire `useDeleteTask` per AD-7.

Additionally, **WARNING-1 (`createdAt` missing from type)** should be fixed at the same time: add `createdAt: string` to `ScheduledTask` and remove the three unsafe casts — this also affects the sort ordering correctness for REQ-KANBAN-6.

Everything else (backend filter, optimistic UI, Kanban visual tokens, URL sync, a11y, route order, test coverage) is solid.
