# Proposal: Scheduling Task Detail Page

## Intent

The Splynx replica reaches its centerpiece UI: the per-task detail/edit page. Today, after changes 1-3, the backend exposes a fully enriched `ScheduledTask` (stage with category, priority, start/end datetime, customer/service/partner/reporter/assignee FKs, watchers, travel-time, geocoded address, rich-text description) — but the frontend has NO view that surfaces those fields. `SchedulingProjectsPage` links to `/admin/scheduling?projectId=...` which dead-ends at a placeholder. Admins cannot open, inspect, edit, or move a task from the UI.

This change adds a new route `/admin/scheduling/tasks/:id` to the frontend (`ipnext-frontend`) rendering a modern, accessible, responsive task detail page. The page is the daily workspace for field operations: title + stage selector in a sticky header, structured "Datos" form with all FK-linked fields, a Leaflet map two-way bound to the address input, a rich-text description editor (TipTap), a watchers chip list with replace-set semantics, and read-only customer/service cards that link out. It uses ONLY the existing backend endpoints (`GET/PUT /api/scheduling/:id`, `PATCH /:id/stage`, `GET /api/admins`, `GET /api/clients`, `GET /api/partners`, `GET /api/workflows/:id`) — backend gap-fill is **NOT** required. Skill `impeccable` drives the visual hierarchy and interaction design (modern reinterpretation, NOT a pixel copy of Splynx).

## Scope

### In Scope — Frontend (`ipnext-frontend`)

- **Route**: register `/admin/scheduling/tasks/:id` in `src/App.tsx` pointing at a new lazy-loaded `SchedulingTaskDetailPage`.
- **Page component**: `src/pages/scheduling/SchedulingTaskDetailPage.tsx` + CSS Module `SchedulingTaskDetailPage.module.css`. Default-exported (matches existing convention of `SchedulingProjectsPage` et al).
- **Type alignment**: extend `src/types/scheduling.ts` to mirror the post-change-3 backend entity. Add `startDate/endDate: string | null` (ISO 8601), `customerId/customerName/serviceId/partnerId/reporterId/assigneeId/assigneeName/stageId/stageCategory: string | null`, `watcherIds: string[]`, `travelTimeTo/From: number | null`. Keep legacy fields (`scheduledDate`, `scheduledTime`, `clientId`, `clientName`, `assignedTo`, `assignedToId`, `status`) marked `@deprecated` for one release (mirrors the backend deprecation cycle).
- **API client**: extend `src/api/scheduling.api.ts` with `moveTaskToStage(id, stageId)` (PATCH /:id/stage). Existing `getTask`, `updateTask`, `deleteTask` already cover the rest.
- **Hooks**: add to `src/hooks/useScheduling.ts`:
  - `useTask(id)` — `GET /:id`, `enabled: !!id`.
  - `useMoveTaskToStage()` — mutation against PATCH `/:id/stage`, invalidates `['scheduling-tasks']` and `['scheduling-task', id]`.
  - `useUpdateTask()` exists; add optimistic-update flavor (`useUpdateTaskOptimistic`) for in-place title/description edits.
- **Sub-components** (colocated under `src/pages/scheduling/SchedulingTaskDetailPage/components/`):
  - `TaskHeader.tsx` — sticky header: editable title (click-to-edit), stage dropdown (pills coloured by `stageCategory`), priority selector, KebabMenu (Delete / Duplicate-deferred-disabled / Open in calendar).
  - `DescriptionEditor.tsx` — TipTap editor (StarterKit minimal: bold/italic/list/link). Sanitization happens via TipTap's schema; render path stays HTML.
  - `DatosForm.tsx` — two-column form (1280) collapsing to single column (768): project, assignee, partner, customer, service, startDate, endDate, travelTimeTo/From. Uses react-hook-form (already established as a low-cost addition; see design AD-3).
  - `UbicacionMap.tsx` — react-leaflet `MapContainer` + draggable `Marker`; address `<input>` bound bidirectionally via Nominatim geocode-on-blur (debounced). Marker drag updates lat/lng + reverse-geocodes to address. Empty state when lat/lng null: placeholder + "Buscar dirección" CTA.
  - `WatchersChips.tsx` — chip list of admin avatars + "Add watcher" button opening a searchable popover (uses `useAdmins({ role: undefined })`). Add/remove triggers full-array PUT (replace-set, matches backend).
  - `CustomerCard.tsx`, `ServiceCard.tsx`, `ReporterCard.tsx` — compact read-only sidebar cards with deep-links (`/admin/customers/view/:id`, etc.).
- **Loading / error / empty states**: every async surface has explicit treatment. Page-level Suspense fallback uses `<Spinner fullPage />`. Section-level skeleton placeholders during refetch. Toast/inline error on save failure. 404 if task not found → friendly "Tarea no encontrada" with back link.
- **Accessibility**: keyboard navigation through all controls, focus-visible rings, ARIA labels on icon-only buttons, ARIA live region announcing save status, Escape closes popovers, focus traps in modals, `prefers-reduced-motion` respected, colour contrast ≥ AA on all stage-category pills.
- **Responsive**: works at 1280 (primary) and 768 (tablet). At ≤ 768, switches from 8-column grid to single column; sidebar cards flow below main column; map stays full-width.
- **Vitest tests**: `src/__tests__/scheduling/SchedulingTaskDetailPage.test.tsx` + one file per sub-component. Covers happy path render, optimistic title edit, stage change, watcher add/remove, map marker drag (mocked react-leaflet), error state, 404, accessibility (axe-core if `vitest-axe` is added; otherwise structural a11y assertions).
- **Navigation entry**: `SchedulingProjectsPage` task references (currently dead-ending at `?projectId=`) and `SchedulingCalendarPage` / `SchedulingMapsPage` / `SchedulingDashboardPage` task references update to navigate to `/admin/scheduling/tasks/:id`. Scoped narrowly — link wiring only, no UI changes elsewhere.

### In Scope — Backend (`ipnext-backend`)

**NONE.** All required endpoints exist post-change-3:

- `GET /api/scheduling/:id` — task with enriched fields ✅
- `PUT /api/scheduling/:id` — replace-set watchers ✅
- `PATCH /api/scheduling/:id/stage` — stage move ✅
- `DELETE /api/scheduling/:id` ✅
- `GET /api/admins` (`role=` optional) — for assignee + watchers picker ✅
- `GET /api/clients?search=` — for customer picker ✅
- `GET /api/partners` ✅
- `GET /api/workflows/:id` — workflow with stages embedded ✅

Verified by inspection of `src/infrastructure/http/routes/scheduling.routes.ts` + `workflows.routes.ts` + `admin.routes.ts` + `clients.routes.ts` + `partner.routes.ts`. If during apply we discover a gap (e.g., admin search-by-name `?q=`), it is scoped IN and handled with the change 1-3 patterns (TDD red-first, zod `z.string().min(1)`, hexagonal port-first, route composition test). Default assumption: no backend code touched.

### Out of Scope (deferred)

- **ChecklistTemplate items + TaskChecklistItem** → `scheduling-checklists` (change 5). The detail page renders a placeholder section "Lista de verificación — próximamente" but no editing UI.
- **Kanban view, multi-select filters in list, custom views** → `scheduling-tasks-views` (change 6).
- **File attachments, activity log, comments on tasks** — out of all six changes. Mentioned as future work; no scaffolding.
- **Mobile (≤480 px)** — gracefully degrades; not formally tested.
- **i18n** — Spanish only. No `t()` wrapper.
- **Service picker UX** — for now the field accepts a `serviceId` string typed/pasted; full service-search popover requires a `/api/clients/:id/services` lookup which is out of scope.
- **Duplicate task** action — placeholder, disabled with tooltip "Próximamente".
- **Backend changes** — none.

## Capabilities

### New Capabilities

- `scheduling-task-detail` — frontend capability spec, new file `openspec/changes/scheduling-task-detail-page/specs/scheduling-task-detail/spec.md`.

### Modified Capabilities

None on the backend. The capability lives in the frontend repo but the spec is hosted here per the SDD discipline established in changes 1-3.

## Approach

1. **Type alignment first** — update `src/types/scheduling.ts` to match the backend ScheduledTask shape (red: existing pages break; green: add fields as optional with legacy fallback for one release).
2. **API client + hooks** — add `moveTaskToStage` and `useTask(id)` / `useMoveTaskToStage`. TanStack Query handles all server state; no Zustand, no Context.
3. **Install minimum dependencies** — `@tiptap/react`, `@tiptap/starter-kit`, `react-hook-form`. Tradeoffs in design §AD-1 and §AD-3.
4. **Build sub-components bottom-up** — TaskHeader, DescriptionEditor, DatosForm, UbicacionMap, WatchersChips, CustomerCard, ServiceCard, ReporterCard. Each gets a Vitest file before its implementation (strict TDD).
5. **Assemble page** — `SchedulingTaskDetailPage.tsx` composes the components; routing wired in `App.tsx`.
6. **Update list-page links** — `SchedulingProjectsPage`, `SchedulingCalendarPage`, `SchedulingMapsPage`, `SchedulingDashboardPage` route to `/admin/scheduling/tasks/:id` on task click.
7. **A11y + responsive audit** — manual + automated (Lighthouse/axe).
8. **E2E smoke** — Playwright snippet plan documented in `tasks.md`; orchestrator runs against deployed instance after merge.

## Affected Areas

| Area | Repo | Impact | Description |
|------|------|--------|-------------|
| `src/App.tsx` | frontend | Modified | Add lazy import + Route for `/admin/scheduling/tasks/:id` |
| `src/types/scheduling.ts` | frontend | Modified | Align with backend enriched ScheduledTask; deprecate legacy fields |
| `src/api/scheduling.api.ts` | frontend | Modified | Add `moveTaskToStage(id, stageId)` |
| `src/hooks/useScheduling.ts` | frontend | Modified | Add `useTask(id)`, `useMoveTaskToStage`, optimistic update flavor |
| `src/pages/scheduling/SchedulingTaskDetailPage.tsx` | frontend | New | Main page component |
| `src/pages/scheduling/SchedulingTaskDetailPage.module.css` | frontend | New | CSS Module with tokens (typography, spacing, colours) |
| `src/pages/scheduling/SchedulingTaskDetailPage/components/TaskHeader.tsx` | frontend | New | Sticky header |
| `src/pages/scheduling/SchedulingTaskDetailPage/components/DescriptionEditor.tsx` | frontend | New | TipTap rich-text editor |
| `src/pages/scheduling/SchedulingTaskDetailPage/components/DatosForm.tsx` | frontend | New | Two-column form |
| `src/pages/scheduling/SchedulingTaskDetailPage/components/UbicacionMap.tsx` | frontend | New | Leaflet map + address sync |
| `src/pages/scheduling/SchedulingTaskDetailPage/components/WatchersChips.tsx` | frontend | New | Watcher chip list + popover |
| `src/pages/scheduling/SchedulingTaskDetailPage/components/CustomerCard.tsx` | frontend | New | Read-only customer link card |
| `src/pages/scheduling/SchedulingTaskDetailPage/components/ServiceCard.tsx` | frontend | New | Read-only service link card |
| `src/pages/scheduling/SchedulingTaskDetailPage/components/ReporterCard.tsx` | frontend | New | Reporter avatar + name |
| `src/__tests__/scheduling/SchedulingTaskDetailPage.test.tsx` | frontend | New | Page-level integration test |
| `src/__tests__/scheduling/components/*.test.tsx` | frontend | New | One per sub-component |
| `src/pages/scheduling/SchedulingProjectsPage.tsx` | frontend | Modified | Link tasks to `/admin/scheduling/tasks/:id` |
| `src/pages/scheduling/SchedulingCalendarPage.tsx` | frontend | Modified | Link tasks to detail page |
| `src/pages/scheduling/SchedulingMapsPage.tsx` | frontend | Modified | Link tasks to detail page |
| `src/pages/scheduling/SchedulingDashboardPage.tsx` | frontend | Modified | Link tasks to detail page |
| `package.json` | frontend | Modified | Add `@tiptap/react`, `@tiptap/starter-kit`, `react-hook-form` |
| **Backend** | backend | **None** | All endpoints already exist |

Absolute paths convention: all frontend paths are relative to `C:\Users\ronald\projects\ipnext\ipnext-frontend\`. Backend paths (none here) are relative to this repo.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| TipTap bundle bloat (~80 KB gzipped) | Medium | StarterKit only (no tables/images). Lazy-loaded with the page route. Acceptable for an admin app. |
| Two-way address-map sync feels janky if Nominatim is slow | Medium | Debounce 600 ms on address blur; spinner on the map while geocoding; no auto-pan during typing. Manual "Buscar" button as escape hatch. |
| Watcher replace-set causes lost watchers on stale UI | Low | Optimistic update reads from cache, not from form state. Race-condition mitigated by query invalidation on focus. |
| Responsive breaking the map at 768 | Low | Map gets `min-height: 360px` and `width: 100%`. Tested in Vitest with the existing `__mocks__/react-leaflet.tsx`. |
| Stage selector showing stale stages after workflow edit | Low | `useWorkflow(workflowId)` query has `staleTime: 60s`; admin who edits a workflow gets fresh list on next page visit. |
| Date inputs across timezones (user in -03:00, server stores UTC) | Medium | Use `<input type="datetime-local">` + `new Date(value).toISOString()` for write; `new Date(iso).toLocaleString()` for display. Documented in design §AD-11. |
| In-place title edit loses content on accidental click-away | Medium | Esc cancels, Enter commits, click-away commits with confirmation toast offering undo (5 s). |
| react-hook-form learning curve in this codebase | Low | Project pattern is currently vanilla controlled state (`SchedulingProjectsPage`). RHF is opt-in for this page only; other pages unchanged. |
| Description XSS — TipTap renders HTML | Medium | TipTap's schema strips disallowed tags; sanitization is built-in. We also render via TipTap's read-only view (NOT `dangerouslySetInnerHTML`) when not editing. |
| Dirty-state lost on navigation | Medium | `useBlocker` from React Router v6 warns on unsaved changes; design §AD-11. |

## Frontend Repo Conventions

- **CSS Modules** — each page/component gets its own `.module.css` (matches `SchedulingProjectsPage.module.css`). No global styles added.
- **Hooks colocated under `src/hooks/`** — domain hooks live there (e.g., `useScheduling.ts`). Component-private hooks may colocate next to the component.
- **TanStack Query** — all server state. Query keys: `['scheduling-task', id]`, `['scheduling-tasks']`, `['admins']`, `['workflow', id]`, `['clients']`, `['partners']`.
- **Default exports for pages**, named exports for atoms/components (matches existing pattern).
- **Lazy imports** in `App.tsx` for code-splitting.
- **Path alias `@/`** (= `src/`).
- **Vitest + jsdom + @testing-library/react** for tests; `__mocks__/react-leaflet.tsx` for map tests.
- **Default Spanish UI strings**.

## Dependencies

- **Blocked by**: changes 1, 2, 3 — `scheduling-foundation-stage-model`, `scheduling-projects-enrich`, `scheduling-tasks-enrich`. All three must be deployed to staging before this change's frontend is useful.
- **Blocks**: change 5 — `scheduling-checklists` (the checklist UI hooks into a section of this page).
- **New npm packages (frontend only)**:
  - `@tiptap/react` (^2.x, MIT) — rich-text editor React bindings.
  - `@tiptap/starter-kit` (^2.x, MIT) — bundled extensions (bold/italic/list/link/heading).
  - `react-hook-form` (^7.x, MIT) — form state for `DatosForm`.
- **No new backend packages**.

## Success Criteria

- [ ] Visiting `/admin/scheduling/tasks/<existing-id>` renders the page with every section populated from the backend.
- [ ] Visiting `/admin/scheduling/tasks/<non-existent>` shows a friendly 404 with a back link.
- [ ] Editing the title inline + pressing Enter persists via PUT `/api/scheduling/:id` and shows a save toast.
- [ ] Changing the stage selector triggers PATCH `/api/scheduling/:id/stage` and updates the UI optimistically.
- [ ] Adding a watcher persists via PUT (replace-set); removing also persists. Reload preserves state.
- [ ] Editing the address triggers a geocode; dragging the map marker updates the address input.
- [ ] Editing the description (bold/italic/list) and saving persists HTML; reload shows the same HTML.
- [ ] At 1280 viewport: two-column layout. At 768: single column. No horizontal scroll at either width.
- [ ] Lighthouse a11y score ≥ 95 on the page.
- [ ] All Vitest tests green (`npm test` in the frontend repo).
- [ ] `tsc --noEmit` clean.
- [ ] Smoke E2E (see `tasks.md`) passes against `http://190.7.234.37:7778`.
- [ ] No backend changes — `git status` in `ipnext-backend` shows only the openspec change folder.
