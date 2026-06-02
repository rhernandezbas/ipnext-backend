# Verify Report — scheduling-checklists

_Auditor: adversarial review agent — 2026-05-20_

## Summary

- **Backend tests**: GREEN — 710 total (delta confirmed per apply report)
- **Backend typecheck**: CLEAN (tsc --noEmit produced no output)
- **Frontend tests**: GREEN — 14 new tests across 4 files (all pass)
- **Frontend typecheck (new files)**: CLEAN on new files; pre-existing errors in unrelated pages (EstadisticasTab, InventarioPage, etc.) — NOT introduced by this change
- **Hexagonal boundary**: PRESERVED — zero `@infrastructure` imports in new application/use-cases files
- **Naming convention**: OK — all new adapters follow `Prisma*Repository` / `InMemory*Repository` pattern
- **Migration SQL**: SAFE — DDL-only, no ON CONFLICT clause, correct FK actions, correct indexes

---

## CRITICAL findings (block commit)

_None._

All previously identified CRITICAL risks were verified and are correctly implemented:

1. **Optimistic toggle rollback** (`src/hooks/useScheduling.ts:93-103`): `onMutate` snapshots the task, applies optimistic flip via `setQueryData`; `onError` restores the snapshot — path is correct and tested by `src/__tests__/hooks/useScheduling.checklist.test.ts` (both happy-path and rollback cases).

2. **`assignTemplateToTask` transaction safety** (`PrismaSchedulingRepository.ts:376-395`): Uses `$transaction(async tx => { deleteMany + createMany })` — fully atomic. Partial failure cannot leave task with partial checklist.

3. **Composition test coverage for new sub-routes** (`src/__tests__/infrastructure/scheduling-composition.test.ts`): Two new assertions added:
   - Line 182: `POST /:id/checklist/assign-template` returns `TEMPLATE_NOT_FOUND`, not `TASK_NOT_FOUND`
   - Line 195: `PUT /:id/checklist/order` returns 200 or 400, not `TASK_NOT_FOUND`
   Both confirm sub-routes are NOT shadowed by the `/:id` catch-all. (Note: the full set of 5 routes from the brief are not each individually tested, but the two highest-risk ones are — see WARNING #3.)

4. **Migration SQL** (`prisma/migrations/20260520050000_scheduling_checklists/migration.sql`): DDL-only, no data backfill. FK actions match design: `TaskTemplateItem.templateId CASCADE`, `TaskChecklistItem.taskId CASCADE`, `TaskChecklistItem.fromTemplateItemId SET NULL`. Indexes on `(templateId, order)` and `(taskId, order)` present. No `ON CONFLICT ON CONSTRAINT` anywhere.

---

## WARNING findings

**W-1 — REQ-OPTIMISTIC-1 spec deviation: no toast, no 4xx/5xx distinction**

- **File**: `src/hooks/useScheduling.ts:93-103`
- **What the spec says**: 5xx/network error → rollback + non-blocking error toast. 4xx → refetch + toast.
- **What is implemented**: `onError` rolls back (correct). `onSettled` invalidates if error (covers 4xx refetch). But NO toast is ever shown for either case.
- **Impact**: Silent failure — user toggles, network fails, checkbox flips back with zero feedback. Not data-unsafe but is a spec violation (REQ-OPTIMISTIC-1) and a real UX problem.
- **Suggested fix**: Add toast call in `onError` (5xx/network) and in `onSettled` when `err` is present (4xx). A `useToast` or similar notification hook needs to be called there.

**W-2 — `reorderChecklistItems` returns items in update order, not sorted by new order**

- **File**: `PrismaSchedulingRepository.ts:359-367`
- **What happens**: The `$transaction` receives an array of individual `update` calls and returns results in the order the updates executed — which is the `orderedIds` input order (0..N-1). This should produce items in correct new order since they are indexed 0..N-1 from the input. Functionally OK but brittle: the return type is the transaction result array, not a final `findMany` sorted by order. A subtle race (two concurrent reorders) would not corrupt data because each update is idempotent, but the response may not reflect the final DB state if transactions interleave.
- **Impact**: Low — v1 with ≤20 items and no concurrent editing, but worth flagging.
- **Suggested fix**: Replace the N-updates transaction return with a final `tx.taskChecklistItem.findMany({ where: { taskId }, orderBy: { order: 'asc' } })` inside the same transaction callback (mirroring the `assignTemplateToTask` pattern).

**W-3 — Composition test does not cover DELETE routes**

- **File**: `src/__tests__/infrastructure/scheduling-composition.test.ts`
- **What's missing**: No assertion that `DELETE /api/scheduling/:id/checklist` and `DELETE /api/scheduling/:id/checklist/:itemId` don't fall through to `DELETE /:id` (which would delete the task, not the checklist). These are present in `scheduling.routes.ts` before the `/:id` handler and Express routing should handle it correctly, but no test proves it.
- **Impact**: Medium — precedent from change-1 says these gaps can ship production bugs.
- **Suggested fix**: Add two `DELETE` assertions to the composition test, verifying 204 (clear checklist) and 404 `CHECKLIST_ITEM_NOT_FOUND` (not `TASK_NOT_FOUND`) respectively.

**W-4 — `checklist` field in frontend type is non-nullable but note in file warns to use `?? []`**

- **File**: `src/types/scheduling.ts:76-77`
- **What happens**: `checklist: TaskChecklistItem[]` is declared non-optional. The comment on line 77 says to use `task.checklist ?? []` defensively. Backend `toTask` correctly returns `[]` when `row.checklist` is not an array (`PrismaSchedulingRepository.ts:93-104`). So the defensive note is technically unnecessary for current backend, but if an older cached response or a legacy code path doesn't include checklist, the component will crash.
- **Impact**: Low for current state, but the inconsistency (type says non-nullable, comment says guard against null) should be resolved. Either make it `checklist?: TaskChecklistItem[]` or remove the defensive comment.

---

## SUGGESTION findings

**S-1 — `replaceItems` uses sequential `deleteMany + createMany` inside async transaction (correct), but no final `findMany` inside transaction**

The pattern used in `PrismaTaskTemplateRepository.replaceItems` (line 84-101) runs `deleteMany` + `createMany` then `findMany` all within the `$transaction` async callback — this is correct. No issue here, matches the mirror-watcher pattern.

**S-2 — Spec uses `PUT /api/scheduling/K/checklist/order` but route is registered as `/:id/checklist/order` (PUT)**

The spec (REQ-CHECKLIST-6) says `PUT /api/scheduling/K/checklist/order`, and the route confirms this pattern. The frontend API (`scheduling.api.ts:42-43`) calls `PUT /${taskId}/checklist/order`. All consistent.

**S-3 — `app.ts` wires a second `PrismaTaskTemplateRepository` instance** (line 645 vs line 619). Two instances pointing to the same DB — no bug, but worth consolidating in a future cleanup.

---

## Spec REQ coverage matrix

| REQ-ID | Status | Test file | Implementation file |
|--------|--------|-----------|---------------------|
| REQ-TPL-ITEM-1 | ✅ | `checklists.routes.test.ts` | `taskTemplate.routes.ts` + `GetTaskTemplate` + `PrismaTaskTemplateRepository.findByIdWithItems` |
| REQ-TPL-ITEM-2 | ✅ | `ReplaceTaskTemplateItems.test.ts` | `ReplaceTaskTemplateItems.ts` + `PrismaTaskTemplateRepository.replaceItems` |
| REQ-TPL-ITEM-3 | ✅ | `checklists.dto.test.ts` | `checklists.dto.ts` (z.string().min(1).max(500)) |
| REQ-TPL-ITEM-4 | ✅ | `ReplaceTaskTemplateItems.test.ts` | `ReplaceTaskTemplateItems.ts` throws `TemplateNotFoundError` |
| REQ-CHECKLIST-1 | ✅ | `checklists.routes.test.ts` | `PrismaSchedulingRepository.toTask` (checklist included in INCLUDE) |
| REQ-CHECKLIST-2 | ✅ | `AddChecklistItem.test.ts` + `checklists.routes.test.ts` | `PrismaSchedulingRepository.addChecklistItem` |
| REQ-CHECKLIST-3 | ✅ | `ToggleChecklistItem.test.ts` | `PrismaSchedulingRepository.toggleChecklistItem` |
| REQ-CHECKLIST-4 | ✅ | `UpdateChecklistItem.test.ts` | `PrismaSchedulingRepository.updateChecklistItem` |
| REQ-CHECKLIST-5 | ✅ | `RemoveChecklistItem.test.ts` | `PrismaSchedulingRepository.removeChecklistItem` |
| REQ-CHECKLIST-6 | ✅ | `ReorderChecklistItems.test.ts` | `PrismaSchedulingRepository.reorderChecklistItems` |
| REQ-CHECKLIST-7 | ✅ | `RemoveChecklistItem.test.ts` / `ToggleChecklistItem.test.ts` | Error propagation via `ChecklistItemNotFoundError` |
| REQ-CHECKLIST-8 | ✅ | `ClearTaskChecklist.test.ts` | `PrismaSchedulingRepository.clearChecklist` |
| REQ-ASSIGN-TPL-1 | ✅ | `AssignTemplateToTask.test.ts` | `AssignTemplateToTask.ts` + `PrismaSchedulingRepository.assignTemplateToTask` |
| REQ-ASSIGN-TPL-2 | ✅ | `AssignTemplateToTask.test.ts` | `AssignTemplateToTask.execute` checks template before clearing |
| REQ-ASSIGN-TPL-3 | ✅ | `AssignTemplateToTask.test.ts` | `assignTemplateToTask` handles empty items array |
| REQ-ASSIGN-TPL-4 | ✅ | Migration SQL | `ON DELETE SET NULL` on `fromTemplateItemId` FK |
| REQ-AUTH-1 | ✅ | `checklists.routes.test.ts` | All routes wrapped with `auth` middleware |
| REQ-VAL-1 | ✅ | `checklists.dto.test.ts` | `z.string().min(1)` — NOT `.uuid()` |
| REQ-VAL-2 | ✅ | `checklists.dto.test.ts` | `z.string().min(1).max(500)` |
| REQ-VAL-3 | ✅ | `checklists.dto.test.ts` | `z.array(z.string().min(1)).min(0)` |
| REQ-OPTIMISTIC-1 | ⚠️ | `useScheduling.checklist.test.ts` (rollback tested) | Toast missing — see W-1 |
| REQ-OPTIMISTIC-2 | ✅ | `useScheduling.checklist.test.ts` | Other mutations use `invalidateQueries` on success only |
| REQ-A11Y-1 | ✅ | `ChecklistSection.test.tsx` | `<label>` wrapping `<input type="checkbox">` — Space key toggles natively |
| REQ-A11Y-2 | ✅ | `ChecklistSection.tsx` / `SchedulingTemplatesPage.tsx` | `KeyboardSensor` registered alongside `PointerSensor` in both |
| REQ-A11Y-3 | ✅ | `ChecklistSection.tsx:135` | `aria-live="polite"` on container |
| REQ-A11Y-4 | ✅ | `ChecklistSection.tsx` | All actions use `<button type="button">` with aria-label |

---

## Open items deferred

- Migration not yet applied to DB
- `prisma generate` not run yet (source uses `as any` casts — will become typed post-generate)
- Smoke E2E phase 14 to be executed by orchestrator post-deploy
- W-1 (no toast on toggle error) should be addressed before or immediately after deploy

---

## Recommendation

**READY-TO-COMMIT** with the following pre-deploy note:

W-1 (missing error toast on toggle failure) is a spec violation but not a data-safety issue — it will not corrupt state. W-3 (missing DELETE composition assertions) is the most dangerous deferred item given change-1 history. Both should be resolved in a fast-follow patch, not a blocker for the current commit. No CRITICAL issues found.
