# Tasks: Scheduling Task Detail Page

All paths under `C:\Users\ronald\projects\ipnext\ipnext-frontend\` unless explicitly noted as backend. Strict TDD red-first per project policy: write the failing Vitest test FIRST, then the production code, then refactor.

---

## Phase 1 — Backend gap-fill

**Outcome**: confirm or add anything the frontend needs that the backend lacks.

- [x] 1.1  Verify by inspection that the following endpoints exist and return the expected shapes:
  - `GET /api/scheduling/:id` returns enriched ScheduledTask incl. `startDate, endDate, customerId, customerName, serviceId, partnerId, reporterId, assigneeId, assigneeName, watcherIds, travelTimeTo, travelTimeFrom, stageId, stageCategory, address, coordinates, description, priority, title`.
  - `PUT /api/scheduling/:id` accepts the same shape, watchers replace-set semantics.
  - `PATCH /api/scheduling/:id/stage` accepts `{ stageId }`.
  - `GET /api/admins` returns `Admin[]` (with `id, name`).
  - `GET /api/clients?search=&page=&pageSize=` returns paginated customer summaries.
  - `GET /api/partners` returns `Partner[]`.
  - `GET /api/workflows/:id` returns workflow with embedded `stages: WorkflowStage[]`.
- [x] 1.2  No backend gaps found. No backend changes required.

---

## Phase 2 — Frontend setup

- [x] 2.1  Install dependencies (frontend repo):
  ```
  npm install @tiptap/react @tiptap/starter-kit react-hook-form
  ```
- [x] 2.2  Update `src/types/scheduling.ts`:
  - Add `startDate, endDate, customerId, customerName, serviceId, partnerId, reporterId, assigneeId, assigneeName, stageId, stageCategory: string | null`.
  - Add `watcherIds: string[]`.
  - Add `travelTimeTo, travelTimeFrom: number | null`.
  - Mark legacy fields `@deprecated` JSDoc.
  - Export `TaskStageCategory = 'nuevo' | 'enProgreso' | 'hecho' | 'cancelado'`.
- [x] 2.3  Update `src/api/scheduling.api.ts`:
  - Add `moveTaskToStage(id: string, stageId: string): Promise<ScheduledTask>` → `PATCH /scheduling/:id/stage`.
- [x] 2.4  Confirm `tsc --noEmit` still passes after type changes (legacy fields stay optional so existing pages compile). ✅ No new errors in our files.

---

## Phase 3 — Hooks

- [x] 3.1  Write `src/__tests__/scheduling/useScheduling.test.ts` covering `useTask(id)` enabled gating + `useMoveTaskToStage` invalidation.
- [x] 3.2  Add to `src/hooks/useScheduling.ts`:
  - `useTask(id: string | undefined)` — `queryKey: ['scheduling-task', id]`, `enabled: !!id`.
  - `useMoveTaskToStage()` — mutation, invalidates `['scheduling-task', id]` + `['scheduling-tasks']`.
  - Make `useUpdateTask()` also invalidate `['scheduling-task', id]` on success.

---

## Phase 4 — Sub-components (each = test first, then implementation)

- [x] 4.1  `TaskHeader`
  - [x] 4.1.1  Write `TaskHeader.test.tsx`: title displays, click → input, Enter → onTitleSave called, Esc → cancel, stage dropdown items coloured by category, kebab opens/closes.
  - [x] 4.1.2  Implement `TaskHeader.tsx` + `.module.css`.
- [x] 4.2  `DescriptionEditor`
  - [x] 4.2.1  Write test: renders initial HTML, typing makes dirty, Guardar calls `onSave` with HTML, save button disabled when not dirty.
  - [x] 4.2.2  Implement using TipTap + StarterKit.
- [x] 4.3  `DatosForm`
  - [x] 4.3.1  Write test: renders all 9 fields with initial values, editing makes dirty, submit calls `onSubmit` with values, end-before-start shows inline error, negative travel-time blocked.
  - [x] 4.3.2  Implement with `react-hook-form`. Datetime conversion as per design AD-12.
- [x] 4.4  `UbicacionMap`
  - [x] 4.4.1  Write test (uses existing `__mocks__/react-leaflet.tsx`): renders map with marker when coords present, renders placeholder when null, address input change debounced → mock geocode → calls `onChange` with new coords.
  - [x] 4.4.2  Implement `UbicacionMap.tsx` + `lib/geocode.ts` (Nominatim wrapper, 600 ms debounce, `User-Agent: ipnext-admin`).
- [x] 4.5  `WatchersChips`
  - [x] 4.5.1  Write test: chips render for each watcherId resolved against admin list, click X → onChange called without that id, click Add → popover opens, select admin → onChange called with appended id.
  - [x] 4.5.2  Implement.
- [x] 4.6  `CustomerCard`
  - [x] 4.6.1  Write test: shows name + link when customerId present, shows empty state with "Vincular" when null.
  - [x] 4.6.2  Implement.
- [x] 4.7  `ServiceCard`
  - [x] 4.7.1  Write test: shows service link when serviceId present, empty when null.
  - [x] 4.7.2  Implement.
- [x] 4.8  `ReporterCard`
  - [x] 4.8.1  Write test: shows reporter name resolved from admin list.
  - [x] 4.8.2  Implement.

---

## Phase 5 — Page assembly + routing

- [x] 5.1  Write `SchedulingTaskDetailPage.test.tsx`:
  - Renders all sections given a mock task.
  - 404 backend → empty state with back link.
  - Loading state → spinner.
  - Title save + stage move + delete flows wired.
  - Dirty-state confirmation on navigation.
- [x] 5.2  Implement `SchedulingTaskDetailPage.tsx` + `.module.css` composing all sub-components, wiring hooks, using `window.onbeforeunload` for confirm-on-leave (note: `useBlocker` requires data router, not supported with MemoryRouter).
- [x] 5.3  Update `src/App.tsx`:
  - Add `const SchedulingTaskDetailPage = lazy(() => import('@/pages/scheduling/SchedulingTaskDetailPage'));`
  - Add route `<Route path="/admin/scheduling/tasks/:id" element={<SchedulingTaskDetailPage />} />` next to the other scheduling routes.
- [x] 5.4  Update list pages to link to the detail page:
  - `SchedulingProjectsPage.tsx` — project title links navigate to `/admin/scheduling?projectId=`. Task references not present in this page as it only shows projects. No change needed.
  - `SchedulingCalendarPage.tsx` — day cell with tasks navigates to first task on click.
  - `SchedulingMapsPage.tsx` — marker popups have "Ver detalle →" link (when taskId present).
  - `SchedulingDashboardPage.tsx` — task list rows have "Ver detalle" action via DataTable actions.
- [x] 5.5  Run `npm test` — full suite green (new tests pass; pre-existing failures unchanged).
- [x] 5.6  Run `npm run typecheck` — clean (no new errors in our files).

---

## Phase 6 — Vitest coverage of spec requirements

Cross-check `specs/scheduling-task-detail/spec.md`. Each REQ-* must have at least one test:

- [x] 6.1  REQ-PAGE-1..4 — page integration test (renders all sections, loading, 404, customer card)
- [x] 6.2  REQ-EDIT-1..4 — TaskHeader + DatosForm + DescriptionEditor tests + dirty-blocker test
- [x] 6.3  REQ-STAGE-MOVE-1..2 — TaskHeader test (stage selector change, category colours via CSS classes)
- [x] 6.4  REQ-WATCHERS-1..3 — WatchersChips test (add, remove, popover search)
- [x] 6.5  REQ-LOCATION-1..5 — UbicacionMap test (map renders, empty state, debounce, address input)
- [x] 6.6  REQ-CUSTOMER-1..2, SERVICE-1, REPORTER-1, DELETE-1 — SideCards tests + page-level delete test
- [x] 6.7  REQ-LOADING-1..2, ERROR-1..2, EMPTY-1..2 — page-level + component tests
- [x] 6.8  REQ-BACKEND-1 — confirmed no backend files changed.

---

## Phase 7 — Accessibility audit

- [ ] 7.1  Tab through the page with keyboard only — every control reachable, focus-visible ring on every focused element.
- [ ] 7.2  Run with `prefers-reduced-motion: reduce` — no animations.
- [ ] 7.3  VoiceOver / NVDA pass: read page top-to-bottom, confirm landmarks, labels, live region announces save status.
- [ ] 7.4  Verify all stage-category pills meet WCAG AA (use a contrast checker — values in design AD-6).
- [ ] 7.5  Lighthouse a11y audit on `/admin/scheduling/tasks/<id>` — score ≥ 95.

**Note**: Structural a11y is in the code (ARIA labels, live regions, semantic HTML, focus-visible). Manual/Lighthouse audit requires deployed instance.

---

## Phase 8 — Responsive testing

- [ ] 8.1  Manual check at 1920, 1440, 1280, 1024, 768, 414, 375 viewport widths.
- [ ] 8.2  No horizontal scroll at any width ≥ 320 px.
- [ ] 8.3  Sticky header remains pinned during scroll.
- [ ] 8.4  Map renders at min-height 360 px at all widths.

**Note**: CSS media queries per AD-10 implemented. Manual check requires deployed app.

---

## Phase 9 — E2E smoke (MANDATORY)

Run by the orchestrator against the deployed app at `http://190.7.234.37:7778` (frontend) + `http://190.7.234.37:7777` (backend) — adjust ports per actual deployment. Use Playwright via the `mcp__playwright__*` tools or local script.

**Pre-flight**: ensure a task exists with all FK fields populated. If none: POST one via `curl`:
```bash
curl -X POST http://190.7.234.37:7777/api/scheduling \
  -H "Cookie: <auth-cookie>" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Smoke Detail Page Test",
    "priority": "high",
    "estimatedHours": 2,
    "category": "installation",
    "startDate": "2026-06-01T14:00:00.000Z",
    "endDate":   "2026-06-01T16:00:00.000Z",
    "customerId": "<existing-customer-id>",
    "assigneeId": "<existing-admin-id>",
    "watcherIds": ["<admin-1>", "<admin-2>"],
    "address": "Av. Corrientes 1234, CABA",
    "coordinates": { "lat": -34.6037, "lng": -58.3816 },
    "travelTimeTo": 30,
    "travelTimeFrom": 30,
    "description": "<p>Cliente solicita instalación en oficina.</p>"
  }'
```
Capture `id` for the steps below.

### Smoke steps (10):

```ts
// 1. Login
await page.goto('http://190.7.234.37:7778/login');
await page.fill('input[name="email"]', 'admin@example.com');
await page.fill('input[name="password"]', '<password>');
await page.click('button[type="submit"]');
await page.waitForURL('**/admin/dashboard');

// 2. Navigate to detail page
await page.goto(`http://190.7.234.37:7778/admin/scheduling/tasks/${taskId}`);
await expect(page.getByRole('heading', { name: /Smoke Detail Page Test/ })).toBeVisible();

// 3. Verify all sections render
await expect(page.getByText('Datos')).toBeVisible();
await expect(page.getByText('Ubicación')).toBeVisible();
await expect(page.getByText('Descripción')).toBeVisible();
await expect(page.getByText('Cliente')).toBeVisible();
await expect(page.getByText('Watchers')).toBeVisible();
await expect(page.getByTestId('map-container')).toBeVisible();

// 4. Edit title inline
await page.getByRole('heading', { name: /Smoke Detail Page Test/ }).click();
await page.keyboard.type(' [edited]');
await page.keyboard.press('Enter');
await expect(page.getByText(/saved|guardado/i)).toBeVisible({ timeout: 5000 });

// 5. Change stage
await page.click('[data-testid="stage-selector"]');
await page.click('text=En progreso');
await expect(page.locator('[data-testid="stage-pill"]')).toHaveText(/En progreso/);

// 6. Add a watcher
await page.click('button:has-text("Añadir watcher")');
await page.fill('input[placeholder*="Buscar"]', 'admin');
await page.click('[data-testid="watcher-result"]:first-child');
await page.waitForResponse(r => r.url().includes('/scheduling/') && r.request().method() === 'PUT');

// 7. Drag map marker (simplified: click then keyboard nudge)
await page.getByTestId('map-marker').click();
await page.keyboard.press('ArrowRight'); // nudges lat/lng
await page.keyboard.press('ArrowRight');

// 8. Save form
await page.click('button:has-text("Guardar cambios")');
await expect(page.getByText(/guardado/i)).toBeVisible({ timeout: 5000 });

// 9. Reload — persistence check
await page.reload();
await expect(page.getByRole('heading', { name: /\[edited\]/ })).toBeVisible();
await expect(page.locator('[data-testid="stage-pill"]')).toHaveText(/En progreso/);

// 10. Delete task (cleanup)
await page.click('[data-testid="kebab-menu"]');
await page.click('text=Eliminar tarea');
await page.click('button:has-text("Eliminar"):not(:has-text("Cancelar"))');
await page.waitForURL('**/admin/scheduling/projects');
```

Acceptance: all 10 steps green. If any fails, capture screenshot + console logs + stop pipeline.

---

## Phase 10 — Commits + PR

- [ ] 10.1  Frontend repo commits, **conventional commits**, no `Co-Authored-By`:
  - `feat(scheduling): add task detail page route and base scaffold`
  - `feat(scheduling): add TaskHeader with editable title and stage selector`
  - `feat(scheduling): add DescriptionEditor with TipTap`
  - `feat(scheduling): add DatosForm with react-hook-form`
  - `feat(scheduling): add UbicacionMap with Leaflet and geocoding`
  - `feat(scheduling): add WatchersChips with replace-set semantics`
  - `feat(scheduling): add Customer/Service/Reporter cards`
  - `feat(scheduling): wire list pages to detail page`
  - `test(scheduling): cover task detail page sub-components`
- [ ] 10.2  Backend repo: single commit if no backend changes — `docs(openspec): add scheduling-task-detail-page change docs`. Otherwise follow change 1-3 commit hygiene.
- [ ] 10.3  Open PR in frontend repo against `main`. PR body lists the 10 smoke steps. Link to the openspec change in `ipnext-backend`.
- [ ] 10.4  After merge + deploy: run the smoke E2E from §9 against production. Mark verify report green.

---

## Definition of Done

- [x] All Phase 6 tests green (Vitest) — 44 new tests passing.
- [ ] All Phase 9 smoke steps green (Playwright on staging then production) — pending orchestrator run.
- [x] `tsc --noEmit` clean (no new errors in our files).
- [ ] Lighthouse a11y ≥ 95 — pending deployed instance.
- [x] No backend code changes.
- [ ] Openspec change archived per `sdd-archive`.
