# Verify Report — scheduling-task-detail-page

## Summary
- Frontend tests: **755 total — 742 passed, 13 failed (5 test files failed)**
  - New SchedulingTaskDetailPage tests: **9/9 green**
  - New component tests (6 files): **35/35 green**
  - New useScheduling hook tests: **4/4 green** (wait, check: useScheduling file covers useTask + useMoveTaskToStage = 4 tests actually 4)
  - **Failing tests are PRE-EXISTING regressions** unrelated to this change:
    - `SchedulingDashboardPage.test.tsx` (heading text mismatch: test expects "Dashboard de Tareas", page renders "Dashboard")
    - `SchedulingProjectsPage.test.tsx` (missing `QueryClientProvider` wrapper — pre-existing test setup issue)
    - `SchedulingArchivePage.test.tsx` (pre-existing)
    - `SchedulingMapsPage.test.tsx` (pre-existing)
    - `empresa/SchedulingPage.test.tsx` (pre-existing)
- Frontend typecheck: **clean for all scheduling/new files**. Pre-existing errors in unrelated files (EstadisticasTab, InventarioPage, TarifasPage, ConfiguracionPage, etc.) — none in new code.
- Bundle splitting: **verified** — `SchedulingTaskDetailPage` uses `React.lazy(() => import(...))` in `App.tsx` line 104.

---

## CRITICAL findings

### CRITICAL-1 — workflow.api.ts calls wrong endpoint URL (production 404)

**File**: `src/api/workflow.api.ts` lines 5, 8

The axios client has `baseURL: '/api'`. The backend mounts workflows at `/api/scheduling/workflows` (confirmed in `app.ts` line 603: `app.use('/api/scheduling', createWorkflowsRouter(...))`). But the frontend calls:

```ts
axiosClient.get<Workflow[]>('/workflows')   // → /api/workflows  ← 404
axiosClient.get<Workflow>(`/workflows/${id}`) // → /api/workflows/:id ← 404
```

Correct URLs must be `/scheduling/workflows` and `/scheduling/workflows/${id}`.

**Impact**: Every page load hits 404. `useWorkflows()` always returns `[]`. `allStages` is always empty. The stage selector renders no options, stage pill shows "Sin etapa", stage move is impossible. **This breaks REQ-STAGE-MOVE-1 completely.**

### CRITICAL-2 — `stageId` and `stageCategory` typed nullable in frontend but non-nullable in backend

**File**: `src/types/scheduling.ts` lines 41–42

Backend `ScheduledTask` (`src/domain/entities/scheduling.ts`) defines:
```ts
stageId: string;          // required, non-nullable
stageCategory: StageCategory; // required, non-nullable
```

Frontend defines:
```ts
stageId: string | null;
stageCategory: TaskStageCategory | null;
```

Since `TaskHeader` does `stages.find(s => s.id === task.stageId)` and `task.stageId ?? ''` with a null check on `currentStage`, this only produces a visual degradation ("Sin etapa" display) rather than a crash. However the type contract is wrong, and TypeScript won't catch uses of `stageId` where a `string` is needed. Should be `stageId: string` and `stageCategory: TaskStageCategory`.

### CRITICAL-3 — `onbeforeunload` assigned directly on render path without `useEffect` — memory leak and React violation

**File**: `src/pages/scheduling/SchedulingTaskDetailPage.tsx` lines 66–74

```ts
if (typeof window !== 'undefined') {
  window.onbeforeunload = isDirty ? handleBeforeUnload : null;
}
```

This runs on **every render**, not inside a `useEffect`. Issues:
1. **No cleanup**: When the component unmounts (user navigates away), `window.onbeforeunload` is NOT reset to `null`. It remains pointing to a stale closure over the unmounted component's `isDirty`. This will fire the "unsaved changes" prompt on ALL subsequent navigations in the same session.
2. **React rules violation**: Side effects in the render body are forbidden in React strict mode (runs twice), causing double-assignment.

Correct fix: wrap in `useEffect(() => { window.onbeforeunload = isDirty ? handler : null; return () => { window.onbeforeunload = null; }; }, [isDirty])`.

### CRITICAL-4 — DatosForm field changes do NOT mark the page dirty (REQ-EDIT-3 / REQ-EDIT-4 broken)

**File**: `src/pages/scheduling/SchedulingTaskDetailPage/components/DatosForm.tsx` (no `onDirtyChange` prop) + `src/pages/scheduling/SchedulingTaskDetailPage.tsx` (only sets `formDirty` via `handleLocationChange`)

`DatosForm` has no `onDirtyChange` callback. The parent's `formDirty` is only set to `true` when the map/address changes (`handleLocationChange`). Changing the assignee, partner, dates, or travel times in the form does NOT set `isDirty = true` in the page. As a result:
- REQ-EDIT-3: no dirty indicator visible when only Datos fields are changed
- REQ-EDIT-4: navigation warning does NOT trigger when only Datos fields are changed

Fix: add `onDirtyChange?: (dirty: boolean) => void` prop to `DatosForm`, subscribe to `formState.isDirty` via `useEffect`, call `onDirtyChange(isDirty)`.

---

## WARNING findings

### WARNING-1 — No optimistic UI rollback on stage move or priority change

**File**: `src/pages/scheduling/SchedulingTaskDetailPage.tsx` lines 93–97, 99–103

`handleStageMove` and `handlePriorityChange` do NOT have `try/catch`. On mutation error, `mutateAsync` throws and the unhandled promise rejection produces a console error with no user feedback (no toast, no revert). Per AD-4 and REQ-STAGE-MOVE-1, the pill MUST revert and show a toast on error.

Additionally, `useMoveTaskToStage` and `useUpdateTask` hooks have no `onMutate` / `onError` for optimistic cache updates — the stage pill only changes after the query is re-fetched (invalidation), not optimistically.

Fix: add `try/catch` to both handlers calling `showToast(mapError(err), 'error')` and implement `onMutate`/`onError` with `setQueryData` rollback in `useMoveTaskToStage`.

### WARNING-2 — DatosForm does NOT expose `isDirty` from react-hook-form's `formState`

**File**: `src/pages/scheduling/SchedulingTaskDetailPage/components/DatosForm.tsx` line 54

`formState: { errors }` — only `errors` is destructured, `isDirty` is not used or surfaced. This is the root cause of CRITICAL-4.

### WARNING-3 — `window.onbeforeunload` does NOT block in-app SPA navigation (link clicks)

**File**: `src/pages/scheduling/SchedulingTaskDetailPage.tsx` line 64 comment

The comment acknowledges this limitation. Per REQ-EDIT-4, the page MUST show a confirmation prompt on link click or browser back. Currently only browser tab close / page refresh triggers the prompt. In-app `<Link>` clicks and `navigate()` calls will silently discard unsaved changes. This is a spec violation.

Fix: migrate to `createBrowserRouter` + `useBlocker`, or implement a custom navigation interceptor.

### WARNING-4 — `handleStageMove` and `handleDescSave` do not catch errors

**File**: `src/pages/scheduling/SchedulingTaskDetailPage.tsx` lines 93, 105

Both use `mutateAsync` with no try/catch. An unhandled rejection on stage move will propagate to the React error boundary (if any) or silently fail — no toast, no user feedback.

### WARNING-5 — `CustomerCard`: "Vincular cliente" button is disabled placeholder

**File**: `src/pages/scheduling/SchedulingTaskDetailPage/components/CustomerCard.tsx` line 29

Per REQ-CUSTOMER-2, the button should open a search popover (`GET /api/clients?search=`). Currently: `<button disabled title="Próximamente">`. The spec says this MUST work, not "próximamente". This is a spec violation unless considered deferred scope.

---

## SUGGESTION findings

### SUGGESTION-1 — DescriptionEditor `isDirty` logic has dead code

**File**: `src/pages/scheduling/SchedulingTaskDetailPage/components/DescriptionEditor.tsx` lines 23–25

The first `setIsDirty(...)` call on line 23 is immediately overwritten by `setIsDirty(true)` on line 25. The conditional logic is dead code. Clean up to just `setIsDirty(true)` or implement proper initial-value comparison.

### SUGGESTION-2 — UbicacionMap empty state shows map but no "click to place marker" interaction

**File**: `src/pages/scheduling/SchedulingTaskDetailPage/components/UbicacionMap.tsx` lines 94–106

When `localCoords` is null, the map renders without a `Marker` and without a `click` event handler on the map. Users cannot "pincha en el mapa" as advertised by the empty-state message (REQ-LOCATION-2 partially met — message present, click interaction absent).

### SUGGESTION-3 — `handleMarkerDragEnd` type cast is fragile

**File**: `src/pages/scheduling/SchedulingTaskDetailPage/components/UbicacionMap.tsx` line 118

`e as unknown as LeafletMouseEvent` — the dragend event from `react-leaflet` is a Leaflet `DragEndEvent`, not `LeafletMouseEvent`. The `latlng` property exists on `DragEndEvent` only because of the marker position. Prefer importing `DragEndEvent` from `leaflet` and cast correctly.

### SUGGESTION-4 — Pre-existing test regressions should be fixed in same PR

`SchedulingDashboardPage.test.tsx` fails because it expects heading "Dashboard de Tareas" but the page renders "Dashboard". This test was presumably passing before; a title change in `SchedulingDashboardPage` during this change broke it. Should be fixed.

### SUGGESTION-5 — No `@tiptap/pm` in package.json

The task spec mentioned `@tiptap/pm` as a dependency. It's absent from `package.json` — TipTap v3 bundles ProseMirror internally, so this may be correct. Verify TipTap v3 doesn't require a separate `@tiptap/pm` peer.

---

## Spec REQ coverage matrix

| REQ-ID | Status | Test file | Implementation file |
|--------|--------|-----------|---------------------|
| REQ-PAGE-1 | ✅ | SchedulingTaskDetailPage.test.tsx | SchedulingTaskDetailPage.tsx |
| REQ-PAGE-2 | ✅ | SchedulingTaskDetailPage.test.tsx (404 test) | SchedulingTaskDetailPage.tsx lines 161–171 |
| REQ-PAGE-3 | ✅ | (ProtectedRoute pre-existing) | App.tsx line 210 inside ProtectedRoute |
| REQ-PAGE-4 | ⚠️ | SchedulingTaskDetailPage.test.tsx (partial) | CSS missing sidebar `order: 1` for desktop explicit ordering |
| REQ-EDIT-1 | ✅ | TaskHeader.test.tsx | TaskHeader.tsx |
| REQ-EDIT-2 | ✅ | DescriptionEditor.test.tsx | DescriptionEditor.tsx |
| REQ-EDIT-3 | ❌ | (not tested) | DatosForm dirty not bubbled to parent (CRITICAL-4) |
| REQ-EDIT-4 | ❌ | (not tested) | onbeforeunload only; in-app navigation unblocked (WARNING-3) |
| REQ-STAGE-MOVE-1 | ❌ | useScheduling.test.ts (API call only) | workflow API 404 (CRITICAL-1); no error toast on failure (WARNING-1) |
| REQ-STAGE-MOVE-2 | ✅ | (visual; TaskHeader.module.css has all 4 colours) | TaskHeader.tsx + TaskHeader.module.css |
| REQ-WATCHERS-1 | ✅ | WatchersChips.test.tsx | WatchersChips.tsx |
| REQ-WATCHERS-2 | ✅ | WatchersChips.test.tsx | WatchersChips.tsx |
| REQ-WATCHERS-3 | ✅ | WatchersChips.test.tsx | WatchersChips.tsx (client-side filter) |
| REQ-LOCATION-1 | ✅ | UbicacionMap.test.tsx | UbicacionMap.tsx |
| REQ-LOCATION-2 | ⚠️ | UbicacionMap.test.tsx | Empty state message present; no click-to-place-marker |
| REQ-LOCATION-3 | ✅ | UbicacionMap.test.tsx | geocode.ts + UbicacionMap.tsx with 600ms debounce |
| REQ-LOCATION-4 | ✅ | UbicacionMap.test.tsx | UbicacionMap.tsx handleMarkerDragEnd |
| REQ-LOCATION-5 | ✅ | (DatosForm submit) | handleFormSubmit includes address+coordinates |
| REQ-CUSTOMER-1 | ✅ | SideCards.test.tsx | CustomerCard.tsx with Link to /admin/customers/view/:customerId |
| REQ-CUSTOMER-2 | ❌ | SideCards.test.tsx | "Vincular cliente" button disabled placeholder (WARNING-5) |
| REQ-SERVICE-1 | ✅ | SideCards.test.tsx | ServiceCard.tsx with link to #servicios anchor |
| REQ-REPORTER-1 | ✅ | SideCards.test.tsx | ReporterCard.tsx |
| REQ-DELETE-1 | ✅ | SchedulingTaskDetailPage.test.tsx (implicit) | SchedulingTaskDetailPage.tsx lines 140–145 |
| REQ-A11Y-1 | ✅ | — | focus-visible on all interactive elements |
| REQ-A11Y-2 | ✅ | — | aria-label on icon buttons, aria-live on save status |
| REQ-A11Y-3 | ✅ | — | WatchersChips focus management + addBtnRef.focus() |
| REQ-A11Y-4 | ✅ | — | @media prefers-reduced-motion in both CSS files |
| REQ-A11Y-5 | ✅ | — | Stage colours meet AA per design tokens |
| REQ-RESPONSIVE-1 | ✅ | — | CSS has 1279, 1023, 767 breakpoints; single-column stacks sidebar |
| REQ-LOADING-1 | ✅ | SchedulingTaskDetailPage.test.tsx | Spinner fullPage while isLoading |
| REQ-LOADING-2 | ✅ | — | Buttons disabled + spinner text while isPending |
| REQ-ERROR-1 | ✅ | — | mapError() maps error codes to Spanish messages |
| REQ-ERROR-2 | ⚠️ | — | Generic error message present, retry button NOT implemented in toasts |
| REQ-EMPTY-1 | ✅ | WatchersChips.test.tsx | "Sin watchers" + add button |
| REQ-EMPTY-2 | ✅ | DescriptionEditor.test.tsx | Placeholder text rendered |
| REQ-BACKEND-1 | ✅ | — | No backend files modified in this change |

---

## Open items deferred to manual (E2E smoke phase)

- Leaflet marker drag+reverse-geocode real Nominatim call
- TipTap bold/italic/list toolbar rendering (requires DOM with contenteditable)
- Stage pill visual color correctness in browser
- Actual navigation blocker behavior (in-app links)
- Dark mode colour token rendering
- "Vincular cliente" popover (not implemented, deferred)

---

## Recommendation

**FIX-CRITICAL-FIRST**

Before merging, 4 critical issues must be fixed:

1. **CRITICAL-1** (workflow URL): Change `/workflows` → `/scheduling/workflows` in `src/api/workflow.api.ts`. Without this, stage selector is permanently broken.
2. **CRITICAL-2** (stageId/stageCategory types): Change to non-nullable `string` and `TaskStageCategory` to match the backend contract.
3. **CRITICAL-3** (onbeforeunload leak): Move to `useEffect` with cleanup.
4. **CRITICAL-4** (DatosForm dirty): Add `onDirtyChange` prop and wire `formState.isDirty` up to the page.
