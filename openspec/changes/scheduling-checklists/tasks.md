# Tasks — scheduling-checklists

All tasks follow strict TDD: write the failing test first (red), make it pass (green), then refactor.
Every task is ≤1 hour. Mark `[x]` when done.

---

## Phase 1 — Backend schema + migration

- [x] **1.1** Add `TaskTemplateItem` model to `prisma/schema.prisma`
  - Fields: `id String @id`, `templateId String`, `text String`, `order Int`, `createdAt DateTime @default(now())`, `updatedAt DateTime @updatedAt`
  - Relation: `template TaskTemplate @relation(fields: [templateId], references: [id], onDelete: Cascade)`
  - Back-relation on `TaskTemplate`: `items TaskTemplateItem[]`
  - Composite index: `@@index([templateId, order])`
  - Acceptance: `npx prisma validate` passes.

- [x] **1.2** Add `TaskChecklistItem` model to `prisma/schema.prisma`
  - Fields: `id String @id`, `taskId String`, `text String`, `done Boolean @default(false)`, `order Int`, `fromTemplateItemId String?`, `createdAt DateTime @default(now())`, `updatedAt DateTime @updatedAt`
  - Relations: `task ScheduledTask @relation(...)`, `fromTemplateItem TaskTemplateItem? @relation(fields: [fromTemplateItemId], references: [id], onDelete: SetNull)`
  - Back-relation on `ScheduledTask`: `checklist TaskChecklistItem[]`
  - Composite index: `@@index([taskId, order])`
  - Acceptance: `npx prisma validate` passes; both models visible in `npx prisma studio`.

- [x] **1.3** Create migration file `prisma/migrations/20260520050000_scheduling_checklists/migration.sql`
  - Content: exact Up SQL from `design.md` (2 CREATE TABLE + 2 CREATE INDEX).
  - Acceptance: `npm run prisma:migrate` applies cleanly on a local dev DB; `prisma migrate status` shows migration applied.

---

## Phase 2 — Backend domain + ports + errors

- [x] **2.1** Create `src/domain/entities/checklist.ts`
  - Export `TaskTemplateItem` and `TaskChecklistItem` interfaces exactly as specified in `design.md`.
  - Acceptance: `tsc --noEmit` passes; no `any`.

- [x] **2.2** Extend `src/domain/entities/taskTemplate.ts`
  - Add `items?: TaskTemplateItem[]` to the `TaskTemplate` interface; import from `checklist.ts`.
  - Acceptance: `tsc --noEmit` passes.

- [x] **2.3** Extend `src/domain/entities/scheduling.ts`
  - Add `checklist?: TaskChecklistItem[]` to `ScheduledTask`; import from `checklist.ts`.
  - Acceptance: `tsc --noEmit` passes.

- [x] **2.4** Extend `src/domain/ports/TaskTemplateRepository.ts`
  - Add `replaceItems(templateId: string, items: { text: string }[]): Promise<TaskTemplateItem[]>`
  - Add `findByIdWithItems(id: string): Promise<(TaskTemplate & { items: TaskTemplateItem[] }) | null>`
  - Acceptance: `tsc --noEmit` passes; existing implementors will fail to compile until updated — that is expected (compiler enforces the contract).

- [x] **2.5** Extend `src/domain/ports/SchedulingRepository.ts`
  - Add 7 methods: `getTaskWithChecklist`, `addChecklistItem`, `toggleChecklistItem`, `updateChecklistItem`, `removeChecklistItem`, `reorderChecklistItems`, `assignTemplateToTask`, `clearChecklist` (signatures from `design.md`).
  - Acceptance: `tsc --noEmit` surfaces only the in-memory/prisma adapter errors (expected).

- [x] **2.6** Create `src/domain/errors/checklist.ts`
  - Export `ChecklistItemNotFoundError`, `TemplateItemNotFoundError`, `OrderingError` — each a named `Error` subclass with a `code` string property.
  - Acceptance: `tsc --noEmit` passes; each error can be `instanceof`-checked.

---

## Phase 3 — Backend application (DTOs + use cases)

- [x] **3.1** Create `src/application/dto/checklists.dto.ts`
  - Zod schemas: `ReplaceTemplateItemsSchema`, `AddChecklistItemSchema`, `UpdateChecklistItemSchema`, `ReorderChecklistSchema`, `AssignTemplateSchema`.
  - REQ-VAL-1: use `z.string().min(1)` for IDs, NOT `z.string().uuid()`.
  - REQ-VAL-2: text fields `z.string().min(1).max(500)`.
  - Export inferred types alongside schemas.
  - Acceptance: Jest unit test in `src/__tests__/application/dto/checklists.dto.test.ts` — empty text returns error, text > 500 chars returns error, valid payload parses OK.

- [x] **3.2** Red: write failing test `src/__tests__/application/use-cases/ReplaceTaskTemplateItems.test.ts`
  - Scenarios: replace empty→3 items (order 0,1,2); replace 3→2 (item 3 deleted); unknown templateId throws `TemplateNotFoundError`.
  - Uses `InMemoryTaskTemplateRepository`.

- [x] **3.3** Green: create `src/application/use-cases/ReplaceTaskTemplateItems.ts`
  - Dependencies: `TaskTemplateRepository`.
  - Logic: call `findByIdWithItems`, throw if null, call `replaceItems`.
  - Acceptance: test from 3.2 passes.

- [x] **3.4** Red+Green: `AddChecklistItem` — test + implement
  - File: `src/__tests__/application/use-cases/AddChecklistItem.test.ts` + `src/application/use-cases/AddChecklistItem.ts`
  - Scenario: appends item with `order = max+1` (or 0 if empty); unknown taskId returns null.
  - Uses `InMemorySchedulingRepository`.

- [x] **3.5** Red+Green: `ToggleChecklistItem` — test + implement
  - File: `src/__tests__/application/use-cases/ToggleChecklistItem.test.ts` + `src/application/use-cases/ToggleChecklistItem.ts`
  - Scenarios: false→true; true→false; unknown itemId throws `ChecklistItemNotFoundError`.

- [x] **3.6** Red+Green: `UpdateChecklistItem` — test + implement
  - File: `src/__tests__/application/use-cases/UpdateChecklistItem.test.ts` + `src/application/use-cases/UpdateChecklistItem.ts`
  - Scenarios: updates text, preserves `done` and `order`; unknown itemId throws `ChecklistItemNotFoundError`.

- [x] **3.7** Red+Green: `RemoveChecklistItem` — test + implement
  - File: `src/__tests__/application/use-cases/RemoveChecklistItem.test.ts` + `src/application/use-cases/RemoveChecklistItem.ts`
  - Scenarios: removes item, returns `true`; unknown id returns `false`.

- [x] **3.8** Red+Green: `ReorderChecklistItems` — test + implement
  - File: `src/__tests__/application/use-cases/ReorderChecklistItems.test.ts` + `src/application/use-cases/ReorderChecklistItems.ts`
  - Scenarios: valid `orderedIds` renumbers 0..N-1; foreign id in list throws `OrderingError` without mutating; missing id throws `OrderingError`.

- [x] **3.9** Red+Green: `AssignTemplateToTask` — test + implement
  - File: `src/__tests__/application/use-cases/AssignTemplateToTask.test.ts` + `src/application/use-cases/AssignTemplateToTask.ts`
  - Scenarios: clears existing checklist + clones template items with correct `fromTemplateItemId`; empty template clears without adding items; unknown templateId throws `TemplateNotFoundError` and does NOT clear the checklist.
  - This is the only use case that coordinates two repositories — depends on both `TaskTemplateRepository` and `SchedulingRepository`.

- [x] **3.10** Red+Green: `ClearTaskChecklist` — test + implement
  - File: `src/__tests__/application/use-cases/ClearTaskChecklist.test.ts` + `src/application/use-cases/ClearTaskChecklist.ts`
  - Scenarios: removes all items; empty task no-ops without error.

---

## Phase 4 — Backend infra (Prisma + InMemory adapters)

- [x] **4.1** Update `InMemoryTaskTemplateRepository` (`src/infrastructure/adapters/in-memory/InMemoryTaskTemplateRepository.ts`)
  - Add in-memory `items: Map<string, TaskTemplateItem[]>` (keyed by templateId).
  - Implement `replaceItems`: delete existing entries for templateId, create new items with generated IDs, assign `order` from array index.
  - Implement `findByIdWithItems`: call `findById`, attach items sorted by `order`.
  - Acceptance: use-case tests from phase 3 that use this repo still pass.

- [x] **4.2** Update `InMemorySchedulingRepository` (`src/infrastructure/adapters/in-memory/InMemorySchedulingRepository.ts`)
  - Add in-memory `checklist: Map<string, TaskChecklistItem[]>` (keyed by taskId).
  - Implement all 7 new port methods; sort by `order` on read; renumber all items in `reorderChecklistItems`.
  - Acceptance: use-case tests from phase 3 pass.

- [x] **4.3** Update `PrismaTaskTemplateRepository` (`src/infrastructure/adapters/prisma/PrismaTaskTemplateRepository.ts`)
  - Extend `INCLUDE` (or equivalent) to include `items: { orderBy: { order: 'asc' } }`.
  - Implement `replaceItems`: `deleteMany({ where: { templateId } })` + `createMany` inside a `$transaction`.
  - Implement `findByIdWithItems`: `findUnique` with items included, map to domain type.
  - Add mapper helper `toTemplateItem(row): TaskTemplateItem`.
  - Acceptance: `tsc --noEmit` passes; manual curl test in phase 14 smoke verifies.

- [x] **4.4** Update `PrismaSchedulingRepository` (`src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts`)
  - Extend `INCLUDE` to include `checklist: { orderBy: { order: 'asc' } }`.
  - Extend `toTask` mapper to map `row.checklist` to `TaskChecklistItem[]` (ISO date strings).
  - Implement `getTaskWithChecklist`: `findUnique` with checklist included.
  - Implement `addChecklistItem`: read max order, `create` with `order = max + 1`.
  - Implement `toggleChecklistItem`: `update` flipping `done` (use `NOT` or read-then-write inside transaction).
  - Implement `updateChecklistItem`: `update` text only.
  - Implement `removeChecklistItem`: `delete`, return `true`; catch Prisma not-found → `false`.
  - Implement `reorderChecklistItems`: verify all IDs belong to task, then loop `update` inside `$transaction`.
  - Implement `assignTemplateToTask`: `$transaction` — `deleteMany checklist`, `createMany` from template items.
  - Implement `clearChecklist`: `deleteMany({ where: { taskId } })`.
  - Acceptance: `tsc --noEmit` passes.

---

## Phase 5 — Backend routes

- [x] **5.1** Extend `src/infrastructure/http/routes/taskTemplate.routes.ts`
  - Add `PUT /:id/items` route: parse `ReplaceTemplateItemsSchema`, call `replaceTaskTemplateItems.execute()`, return items array.
  - Add `ReplaceTaskTemplateItems` use-case parameter to `createTaskTemplateRouter` factory.
  - Acceptance: `tsc --noEmit` passes.

- [x] **5.2** Extend `src/infrastructure/http/routes/scheduling.routes.ts` — add 7 checklist sub-routes (register ALL before `/:id` to avoid shadowing):
  - `POST /:id/checklist` → `addChecklistItem.execute(id, body.text)` → 201
  - `POST /:id/checklist/assign-template` → `assignTemplateToTask.execute(id, body.templateId)` → 200
  - `DELETE /:id/checklist` → `clearTaskChecklist.execute(id)` → 204
  - `PUT /:id/checklist/order` → `reorderChecklistItems.execute(id, body.orderedIds)` → 200
  - `PATCH /:id/checklist/:itemId/toggle` → `toggleChecklistItem.execute(itemId)` → 200
  - `PATCH /:id/checklist/:itemId` → `updateChecklistItem.execute(itemId, body.text)` → 200
  - `DELETE /:id/checklist/:itemId` → `removeChecklistItem.execute(itemId)` → 204
  - Add 5 new use-case parameters to `createSchedulingRouter` factory.
  - Map `ChecklistItemNotFoundError` → 404 `CHECKLIST_ITEM_NOT_FOUND`; `TemplateNotFoundError` → 404 `TEMPLATE_NOT_FOUND`; `OrderingError` → 400 `VALIDATION_ERROR`.
  - Acceptance: `tsc --noEmit` passes; route order confirmed by composition test.

---

## Phase 6 — Backend wiring (app.ts)

- [x] **6.1** Wire new use cases in `src/infrastructure/http/app.ts` (~15 lines)
  - Instantiate `PrismaTaskTemplateRepository` with items support (should already exist; confirm it satisfies the updated port).
  - Instantiate 8 new use cases: `ReplaceTaskTemplateItems`, `AddChecklistItem`, `ToggleChecklistItem`, `UpdateChecklistItem`, `RemoveChecklistItem`, `ReorderChecklistItems`, `AssignTemplateToTask`, `ClearTaskChecklist`.
  - Pass `ReplaceTaskTemplateItems` to `createTaskTemplateRouter`.
  - Pass 5 checklist use cases to `createSchedulingRouter`.
  - Acceptance: `tsc --noEmit` passes; `npm run dev` starts without errors.

---

## Phase 7 — Backend integration tests

- [x] **7.1** Red: write route tests `src/__tests__/infrastructure/checklists.routes.test.ts`
  - Use supertest + `InMemory*` repos + `FakeAuthProvider`.
  - Cover: `PUT /api/scheduling/task-templates/:id/items` (200, 400 validation, 404 not found).
  - Cover all 7 checklist sub-routes: 201 add, 200 toggle, 200 update, 204 remove, 200 reorder, 200 assign-template, 204 clear.
  - Cover 401 on missing cookie for at least one route.
  - Acceptance: tests fail (red) before phase 5/6 are done; pass after.

- [x] **7.2** Extend `src/__tests__/infrastructure/scheduling-composition.test.ts`
  - Add `InMemoryTaskTemplateRepository`, 5 new use-case imports, updated `createSchedulingRouter` call.
  - Add test: `POST /api/scheduling/<id>/checklist/assign-template` returns NOT `TASK_NOT_FOUND` (should be 404 `TEMPLATE_NOT_FOUND` or similar, NOT the /:id catch-all).
  - Add test: `PUT /api/scheduling/<id>/checklist/order` returns NOT `TASK_NOT_FOUND` (should be 400 `VALIDATION_ERROR` on empty body or 200 on valid body).
  - Acceptance: all existing + new composition tests pass.

- [x] **7.3** Run `npm test` — all backend tests green
  - Acceptance: zero failing tests; coverage on new use cases ≥ 80%.

---

## Phase 8 — Frontend types alignment

- [x] **8.1** Extend `src/types/taskTemplate.ts` (frontend repo)
  - Add `TaskTemplateItem` interface (matching domain entity).
  - Add `items?: TaskTemplateItem[]` to `TaskTemplate`.
  - Acceptance: `tsc --noEmit` (frontend) passes.

- [x] **8.2** Extend `src/types/scheduling.ts` (frontend repo)
  - Add `TaskChecklistItem` interface.
  - Add `checklist: TaskChecklistItem[]` to `ScheduledTask` (required, defaults to `[]` from API).
  - Acceptance: `tsc --noEmit` (frontend) passes.

---

## Phase 9 — Frontend hooks

- [x] **9.1** Extend `src/api/taskTemplate.api.ts`
  - Add `replaceTemplateItems(id: string, items: { text: string }[]): Promise<TaskTemplateItem[]>`
  - Acceptance: TypeScript compiles.

- [x] **9.2** Extend `src/api/scheduling.api.ts`
  - Add 7 functions: `addChecklistItem`, `toggleChecklistItem`, `updateChecklistItem`, `removeChecklistItem`, `reorderChecklist`, `assignTemplateToTask`, `clearChecklist`.
  - Acceptance: TypeScript compiles.

- [x] **9.3** Extend `src/hooks/useTaskTemplates.ts`
  - Add `useReplaceTemplateItems()` mutation — on success invalidate `['taskTemplate', id]` and `['taskTemplates']`.
  - Acceptance: `tsc --noEmit` passes.

- [x] **9.4** Extend `src/hooks/useScheduling.ts`
  - Add `useAddChecklistItem(taskId)` — invalidates `['task', taskId]` on success.
  - Add `useToggleChecklistItem(taskId)` — optimistic: `onMutate` snapshot + flip; `onError` rollback + toast; `onSettled` invalidate on 4xx.
  - Add `useUpdateChecklistItem(taskId)` — invalidates on success.
  - Add `useRemoveChecklistItem(taskId)` — invalidates on success.
  - Add `useReorderChecklist(taskId)` — invalidates on success.
  - Add `useAssignTemplateToTask(taskId)` — invalidates on success.
  - Add `useClearChecklist(taskId)` — invalidates on success.
  - Acceptance: `tsc --noEmit` passes; optimistic toggle test (phase 12) passes.

---

## Phase 10 — Frontend TemplatesPage item editor

- [x] **10.1** Update `src/pages/scheduling/SchedulingTemplatesPage.tsx`
  - Install `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` in frontend `package.json` (if not already present).
  - Expand the existing template edit modal to render an item list editor below Name/Description/Category fields.
  - Item list: each item has a drag handle (dnd-kit `useSortable`), inline text input, delete button.
  - "Add item" button at the bottom appends an empty item to local state.
  - On modal save, call `useReplaceTemplateItems` with the current list.
  - Empty state: "Sin elementos. Agregá el primero abajo."
  - Keyboard reorder: `KeyboardSensor` + `SortableContext` — REQ-A11Y-2.
  - Acceptance: `tsc --noEmit` passes; item editor visible in modal; drag reorder works.

- [x] **10.2** Update `src/pages/scheduling/SchedulingTemplatesPage.module.css`
  - Add styles for the item list editor (item row, drag handle, text input, delete button, empty state).
  - Acceptance: no visual regressions on existing template list.

---

## Phase 11 — Frontend TaskDetailPage checklist (replace placeholder)

- [x] **11.1** Create `src/pages/scheduling/SchedulingTaskDetailPage/components/ChecklistSection.tsx`
  - Props: `taskId: string`, `checklist: TaskChecklistItem[]`.
  - Renders checklist items as `<label><input type="checkbox">` (REQ-A11Y-1).
  - Container has `aria-live="polite"` (REQ-A11Y-3).
  - Toggle calls `useToggleChecklistItem` (optimistic — REQ-OPTIMISTIC-1).
  - Inline "Añadir elemento" input + button (REQ-A11Y-4) calls `useAddChecklistItem`.
  - Edit-in-place on item text calls `useUpdateChecklistItem`.
  - Delete button per item calls `useRemoveChecklistItem`.
  - Drag reorder (dnd-kit sortable) calls `useReorderChecklist` on drop.
  - "Cargar lista" button opens `AssignTemplateDialog`.
  - "Limpiar lista" button with confirm calls `useClearChecklist`.
  - Empty state: existing placeholder copy + "Cargar lista" + "Añadir elemento" (REQ-A11Y-4).
  - Acceptance: renders without errors; `tsc --noEmit` passes.

- [x] **11.2** Create `src/pages/scheduling/SchedulingTaskDetailPage/components/ChecklistSection.module.css`
  - Styles: item row layout, checkbox, text, drag handle, action buttons, progress indicator (X / N done), empty state.
  - Acceptance: no layout overflow; accessible focus rings visible.

- [x] **11.3** Create `src/pages/scheduling/SchedulingTaskDetailPage/components/AssignTemplateDialog.tsx`
  - Shows a modal/dialog with a list of available templates (from `useTaskTemplates`).
  - If task already has checklist items, shows a warning: "Esto reemplazará tu lista actual. ¿Continuás?"
  - Confirm button calls `useAssignTemplateToTask`; cancel dismisses without mutating.
  - Buttons use `<button>` elements with accessible names (REQ-A11Y-4).
  - Acceptance: `tsc --noEmit` passes; confirm fires mutation; cancel does not.

- [x] **11.4** Create `src/pages/scheduling/SchedulingTaskDetailPage/components/AssignTemplateDialog.module.css`
  - Acceptance: dialog styled, overlay visible.

- [x] **11.5** Replace placeholder in `src/pages/scheduling/SchedulingTaskDetailPage.tsx`
  - Remove the `<section className={styles.checklistPlaceholder}>` block (lines ~232-233).
  - Import and render `<ChecklistSection taskId={id!} checklist={task.checklist ?? []} />`.
  - Acceptance: `tsc --noEmit` passes; placeholder no longer visible; real checklist renders.

---

## Phase 12 — Frontend Vitest tests

- [x] **12.1** Create `src/__tests__/ChecklistSection.test.tsx`
  - Render with 3 mock items.
  - Click a checkbox → verify `useToggleChecklistItem` mutate called with correct itemId.
  - Optimistic test: mock API to reject → verify checkbox rolls back to prior state.
  - Empty list → verify empty state and "Añadir elemento" button present.
  - Acceptance: all tests pass (`npm test` or `npx vitest run`).

- [x] **12.2** Create `src/__tests__/AssignTemplateDialog.test.tsx`
  - Render with templates list.
  - Select a template + confirm → verify `useAssignTemplateToTask` called.
  - Cancel → verify mutation NOT called.
  - Warning shown when task already has items.
  - Acceptance: all tests pass.

- [x] **12.3** Create `src/__tests__/hooks/useScheduling.checklist.test.ts`
  - Test `useToggleChecklistItem` optimistic behavior:
    - Setup: render hook with a query cache seeded with 1 checklist item (`done: false`).
    - Call mutate(itemId).
    - Before `await`: assert cache shows `done: true` (optimistic applied).
    - Resolve API with error → assert cache shows `done: false` (rollback).
  - Mock at the API layer (`src/api/scheduling.api.ts`), not `queryClient`.
  - Acceptance: test passes.

- [x] **12.4** Create `src/__tests__/TemplatesPage.items.test.tsx`
  - Open edit modal for a template with 2 items.
  - Add a third item via "Agregá el primero" or "Add item" button.
  - Save → verify `useReplaceTemplateItems` called with all 3 texts.
  - Delete item 1 → save → verify called with 2 texts.
  - Acceptance: all tests pass.

---

## Phase 13 — Final verification

- [x] **13.1** Backend: run `npx tsc --noEmit` — zero errors
  - File: `tsconfig.json` (no changes needed, just run).

- [x] **13.2** Backend: run `npm test` — all tests green
  - Verify no regressions in pre-existing tests.
  - New tests from phases 3, 7 all pass.

- [x] **13.3** Frontend: run `npx tsc --noEmit` — zero errors

- [x] **13.4** Frontend: run `npm test` (Vitest) — all tests green
  - New tests from phase 12 all pass.

---

## Phase 14 — Smoke E2E plan

Run both repos locally: `npm run dev` in each. Backend at `http://localhost:3000`, frontend at `http://localhost:5173`.

### Step 1 — Login (curl)

```bash
curl -s -c cookies.txt -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}' | jq .
# Expected: { "user": { ... } }
```

### Step 2 — Create template with items (curl)

```bash
# Create template (no items yet — items are replaced via separate endpoint)
TPL=$(curl -s -b cookies.txt -X POST http://localhost:3000/api/scheduling/task-templates \
  -H "Content-Type: application/json" \
  -d '{"name":"Instalación fibra","description":"Checklist estándar","category":"installation"}' | jq -r '.id')
echo "Template ID: $TPL"

# Replace items (3 items)
curl -s -b cookies.txt -X PUT "http://localhost:3000/api/scheduling/task-templates/$TPL/items" \
  -H "Content-Type: application/json" \
  -d '{"items":[{"text":"Verificar señal ONU"},{"text":"Configurar router"},{"text":"Test de velocidad"}]}' | jq .
# Expected: array of 3 items with order 0, 1, 2
```

### Step 3 — Create a scheduled task (curl)

```bash
TASK=$(curl -s -b cookies.txt -X POST http://localhost:3000/api/scheduling \
  -H "Content-Type: application/json" \
  -d '{"title":"Instalación cliente García","priority":"medium","estimatedHours":2,"category":"installation"}' \
  | jq -r '.id')
echo "Task ID: $TASK"
```

### Step 4 — Assign template → verify items cloned (curl)

```bash
curl -s -b cookies.txt -X POST "http://localhost:3000/api/scheduling/$TASK/checklist/assign-template" \
  -H "Content-Type: application/json" \
  -d "{\"templateId\":\"$TPL\"}" | jq .
# Expected: array of 3 checklist items, done=false, fromTemplateItemId set for each
```

### Step 5 — Toggle item (curl)

```bash
ITEM=$(curl -s -b cookies.txt "http://localhost:3000/api/scheduling/$TASK" | jq -r '.checklist[0].id')
curl -s -b cookies.txt -X PATCH "http://localhost:3000/api/scheduling/$TASK/checklist/$ITEM/toggle" | jq .
# Expected: { "done": true, ... }
# Toggle again:
curl -s -b cookies.txt -X PATCH "http://localhost:3000/api/scheduling/$TASK/checklist/$ITEM/toggle" | jq .
# Expected: { "done": false, ... }
```

### Step 6 — Add ad-hoc item (curl)

```bash
curl -s -b cookies.txt -X POST "http://localhost:3000/api/scheduling/$TASK/checklist" \
  -H "Content-Type: application/json" \
  -d '{"text":"Fotografiar instalación completa"}' | jq .
# Expected: new item with order=3, done=false, fromTemplateItemId=null
```

### Step 7 — Reorder items (curl)

```bash
# Get current item IDs in order
IDS=$(curl -s -b cookies.txt "http://localhost:3000/api/scheduling/$TASK" \
  | jq '[.checklist[].id]')
# Reverse order for test
REVERSED=$(echo $IDS | jq 'reverse')
curl -s -b cookies.txt -X PUT "http://localhost:3000/api/scheduling/$TASK/checklist/order" \
  -H "Content-Type: application/json" \
  -d "{\"orderedIds\":$REVERSED}" | jq '.[].order'
# Expected: 0, 1, 2, 3 in new sequence
```

### Step 8 — Delete an item (curl)

```bash
# Delete the ad-hoc item (last in original order)
ADHOC_ITEM=$(curl -s -b cookies.txt "http://localhost:3000/api/scheduling/$TASK" \
  | jq -r '.checklist[] | select(.fromTemplateItemId == null) | .id')
curl -s -b cookies.txt -X DELETE "http://localhost:3000/api/scheduling/$TASK/checklist/$ADHOC_ITEM"
# Expected: HTTP 204
# Verify it's gone:
curl -s -b cookies.txt "http://localhost:3000/api/scheduling/$TASK" | jq '.checklist | length'
# Expected: 3
```

### Step 9 — Playwright: verify frontend checklist

```ts
// playwright/smoke/checklist.spec.ts
import { test, expect } from '@playwright/test';

test('checklist renders and optimistic toggle works', async ({ page }) => {
  // Navigate to task detail page
  await page.goto(`http://localhost:5173/scheduling/${TASK_ID}`);

  // Wait for checklist to load
  const checklistSection = page.getByRole('region', { name: /lista de verificación/i });
  await expect(checklistSection).toBeVisible();

  // Verify 3 items rendered
  const items = page.getByRole('checkbox');
  await expect(items).toHaveCount(3);

  // First checkbox is unchecked
  const firstCheckbox = items.first();
  await expect(firstCheckbox).not.toBeChecked();

  // Click → optimistic update → visually checked immediately
  await firstCheckbox.click();
  await expect(firstCheckbox).toBeChecked(); // optimistic

  // Wait for network confirmation (no rollback expected)
  await page.waitForTimeout(500);
  await expect(firstCheckbox).toBeChecked(); // persisted

  // Reload → verify state persisted
  await page.reload();
  await expect(page.getByRole('checkbox').first()).toBeChecked();
});

test('assign template dialog shows confirmation when checklist has items', async ({ page }) => {
  await page.goto(`http://localhost:5173/scheduling/${TASK_ID}`);
  await page.getByRole('button', { name: /cargar lista/i }).click();
  // Warning visible because task already has items
  await expect(page.getByText(/reemplazará tu lista/i)).toBeVisible();
  // Cancel
  await page.getByRole('button', { name: /cancelar/i }).click();
  // Checklist unchanged (still 3 items)
  await expect(page.getByRole('checkbox')).toHaveCount(3);
});
```

### Step 10 — Cleanup (curl)

```bash
# Delete task (cascades checklist items)
curl -s -b cookies.txt -X DELETE "http://localhost:3000/api/scheduling/$TASK"
# Expected: HTTP 204

# Delete template (cascades template items; fromTemplateItemId on checklist already SET NULL)
curl -s -b cookies.txt -X DELETE "http://localhost:3000/api/scheduling/task-templates/$TPL"
# Expected: HTTP 204

# Verify both gone
curl -s -b cookies.txt "http://localhost:3000/api/scheduling/$TASK" | jq .code
# Expected: "TASK_NOT_FOUND"
curl -s -b cookies.txt "http://localhost:3000/api/scheduling/task-templates/$TPL" | jq .code
# Expected: "TEMPLATE_NOT_FOUND"
```

### Step 10b — Save apply-progress to engram

After the apply phase is complete, the implementing agent MUST call:

```
mem_save(
  title: "scheduling-checklists apply phase complete",
  type: "architecture",
  topic_key: "sdd/scheduling-checklists/apply-progress",
  project: "ipnext-backend",
  content: {
    What: "All 14 phases implemented: schema, domain, use cases, adapters, routes, wiring, tests, frontend types/hooks/components.",
    Why: "scheduling-checklists change 5 apply phase",
    Where: [
      "prisma/schema.prisma",
      "src/domain/entities/checklist.ts",
      "src/domain/ports/TaskTemplateRepository.ts",
      "src/domain/ports/SchedulingRepository.ts",
      "src/application/dto/checklists.dto.ts",
      "src/application/use-cases/* (8 new)",
      "src/infrastructure/adapters/prisma/Prisma{TaskTemplate,Scheduling}Repository.ts",
      "src/infrastructure/adapters/in-memory/InMemory{TaskTemplate,Scheduling}Repository.ts",
      "src/infrastructure/http/routes/{taskTemplate,scheduling}.routes.ts",
      "src/infrastructure/http/app.ts",
      "frontend: types, api, hooks, ChecklistSection, AssignTemplateDialog, TemplatesPage"
    ],
    Learned: "Route order critical: all /:id/checklist/* sub-routes MUST be registered before /:id PUT/GET in scheduling router. Composition test covers this."
  }
)
```
