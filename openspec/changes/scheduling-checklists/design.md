# Design — scheduling-checklists

## Technical Approach

This change extends two existing surfaces with minimal coupling. `TaskTemplate` gains ordered `TaskTemplateItem` records managed via a replace-set port method (`replaceItems`) that mirrors the `ProjectPartner` and `TaskWatcher` patterns from changes 2 and 3: the frontend admin form always submits the entire item list, so replace-set is the natural shape — one transaction, no partial-update edge cases. `ScheduledTask` gains a `TaskChecklistItem` collection managed via individual-endpoint port methods because toggle is the hot path: each checkbox click should issue one POST, not serialize and resend the entire list. `AssignTemplateToTask` is the only operation that touches both surfaces; it is intentionally destructive (REPLACE semantics) and lives behind a confirm dialog in the UI to prevent accidental data loss.

The migration is purely additive DDL — two new tables, two composite indexes, no backfill. Old frontend clients continue working unchanged because `checklist` defaults to `[]` in the API response and `items` was not previously present on `TaskTemplate`. Frontend uses TanStack Query optimistic updates only for the toggle mutation (the hot path) and waits for server confirmation on all other mutations to avoid duplicate IDs and ordering inconsistencies. Drag-reorder uses `@dnd-kit/sortable` which ships accessible keyboard sensors by default, satisfying REQ-A11Y-2 without extra wiring.

## Architecture Decisions

### AD-1 — Template items use replace-set port shape

**Choice**: Single port method `replaceItems(templateId, items: { text: string; order: number }[]): Promise<TaskTemplateItem[]>` replacing the entire set atomically inside a `deleteMany` + `createMany` transaction. `order` is assigned from the input array index server-side.

**Alternatives**:
- Per-item add/update/remove/reorder methods on the port.
- LexoRank fractional ordering strings.

**Rationale**: Mirrors `TaskWatcher` replace-set in `PrismaSchedulingRepository.updateTask` and the upcoming `ProjectPartner` pattern — consistent port shape across the codebase. The admin always saves the complete item list in one form submit; a batch replace is safer than a series of diffs that could leave stale items. LexoRank is unnecessary overhead for lists bounded at ~20 items; plain integer `order` with renumber-on-save is O(N) and trivially correct.

### AD-2 — Checklist items use individual endpoints

**Choice**: Per-item endpoints (`addChecklistItem`, `toggleChecklistItem`, `updateChecklistItem`, `removeChecklistItem`) plus a separate `reorderChecklistItems` endpoint that takes the full ordered ID array.

**Alternatives**: Replace-set for the entire checklist (like templates).

**Rationale**: `toggleChecklistItem` is the hot path — clicking a checkbox must be instant. Replace-set would require the frontend to hold the full list in state and serialize it on every toggle, introducing race conditions if two tabs are open. Individual endpoints keep each mutation minimal and idempotent. Reorder is rare enough that a full-array endpoint is fine.

### AD-3 — `order` is plain integer with renumber-on-reorder

**Choice**: `Int` column with consecutive 0..N values. Server renumbers all items in a single UPDATE inside a transaction on each reorder.

**Alternatives**: LexoRank / fractional string keys.

**Rationale**: Checklists are bounded (~20 items max, matching Splynx UX). O(N) renumber per reorder is imperceptible. Integer column keeps schema simple, queries readable, and avoids the lexicographic sort complexity of fractional keys. If lists ever exceed hundreds of items this decision should be revisited.

### AD-4 — `assignTemplateToTask` REPLACES existing checklist

**Choice**: Backend operation runs `clearChecklist` + `createMany` inside a single Prisma transaction. Frontend shows a confirm dialog when the task already has items.

**Alternatives**: APPEND mode (merge template items into existing checklist).

**Rationale**: Matches Splynx UX — "Cargar la lista de verificación" implies load-from-scratch. The confirm dialog protects against accidental data loss. An APPEND mode can be added as a separate endpoint in change 6 if requested without touching this operation.

### AD-5 — Optimistic UI only for toggle

**Choice**: TanStack Query `useMutation` with `onMutate` snapshot + `onError` rollback on `useToggleChecklistItem`. All other checklist mutations (`add`, `update`, `remove`, `reorder`) wait for the server response before updating the cache.

**Alternatives**: Optimistic updates for all mutations.

**Rationale**: Toggle is the only interaction where instant feedback is observable and expected (checkbox flips). Add/update/remove/reorder need server-generated IDs or definitive order values; optimistic versions would require temporary IDs and complex reconciliation. The tradeoff (per REQ-OPTIMISTIC-2) is explicitly accepted in v1.

### AD-6 — `@dnd-kit/core` + `@dnd-kit/sortable` for drag-and-drop

**Choice**: `@dnd-kit/core` + `@dnd-kit/sortable` + `@dnd-kit/utilities`.

**Alternatives**:
- `react-beautiful-dnd` — deprecated, no React 18 support, larger bundle (~30 KB gzip).
- `react-sortable-hoc` — deprecated.
- Custom HTML5 DnD API — poor accessibility, no keyboard support out of the box.

**Rationale**: dnd-kit is the modern standard for React drag-and-drop. ~12 KB gzip total. Ships keyboard sensors (Space to grab, arrow keys to move, Space/Enter to drop) that satisfy REQ-A11Y-2 without additional ARIA wiring. Already referenced in the proposal and spec.

### AD-7 — Template item editor is inline in the existing edit modal

**Choice**: The existing `SchedulingTemplatesPage` edit modal expands to include an item list editor below the Name/Description/Category fields.

**Alternatives**: Separate page per template; two-step modal (step 1 = metadata, step 2 = items).

**Rationale**: Matches the existing single-modal UX. Items are tightly coupled to their template — visual grouping is natural and saves a navigation hop. The modal can be made scrollable if item lists grow long. Implementation reuses the existing modal open/close state with no new routing.

### AD-8 — Empty-state visuals

**Choice**: Template with no items shows "Sin elementos. Agregá el primero abajo." with a focused input at the bottom of the editor. Task with no checklist shows the existing placeholder copy plus a "Cargar lista" button (opens template picker) and an "Añadir elemento" inline input.

**Rationale**: Maintains visual consistency with other empty states in the project (clients list, projects list). Makes the primary action (add first item / load from template) immediately discoverable without an extra click.

## Data Flow Diagram

```
User clicks checkbox
        │
        ▼
React: snapshot checklist in queryClient cache (onMutate)
        │
        ▼
UI flips checkbox IMMEDIATELY (optimistic)
        │
        ▼
POST /api/scheduling/:taskId/checklist/:itemId/toggle
        │
       / \
      /   \
  2xx       5xx / network error
   │              │
   ▼              ▼
No-op        onError: rollback snapshot → queryClient.setQueryData
(optimistic   surface error toast
 already ok)
        │
        ▼ (4xx)
     onError: queryClient.invalidateQueries(['task', taskId])
     surface toast (item may not exist — reconcile from server)
```

## File Changes

### Backend

| File | Action | Notes |
|------|--------|-------|
| `prisma/schema.prisma` | modify | Add `TaskTemplateItem` + `TaskChecklistItem` models, back-relations on `TaskTemplate` + `ScheduledTask` |
| `prisma/migrations/20260520050000_scheduling_checklists/migration.sql` | new | DDL only — 2 CREATE TABLE + 2 CREATE INDEX |
| `src/domain/entities/checklist.ts` | new | `TaskTemplateItem` + `TaskChecklistItem` interfaces |
| `src/domain/entities/taskTemplate.ts` | modify | Add `items?: TaskTemplateItem[]` |
| `src/domain/entities/scheduling.ts` | modify | Add `checklist?: TaskChecklistItem[]` |
| `src/domain/ports/TaskTemplateRepository.ts` | modify | Add `replaceItems`, `findByIdWithItems` |
| `src/domain/ports/SchedulingRepository.ts` | modify | Add 7 checklist methods |
| `src/domain/errors/checklist.ts` | new | `ChecklistItemNotFoundError`, `TemplateItemNotFoundError`, `OrderingError` |
| `src/application/dto/checklists.dto.ts` | new | Zod schemas for all checklist operations |
| `src/application/use-cases/ReplaceTaskTemplateItems.ts` | new | |
| `src/application/use-cases/AddChecklistItem.ts` | new | |
| `src/application/use-cases/ToggleChecklistItem.ts` | new | |
| `src/application/use-cases/UpdateChecklistItem.ts` | new | |
| `src/application/use-cases/RemoveChecklistItem.ts` | new | |
| `src/application/use-cases/ReorderChecklistItems.ts` | new | |
| `src/application/use-cases/AssignTemplateToTask.ts` | new | |
| `src/application/use-cases/ClearTaskChecklist.ts` | new | |
| `src/infrastructure/adapters/prisma/PrismaTaskTemplateRepository.ts` | modify | Add `replaceItems` + `findByIdWithItems`; extend INCLUDE with `items` |
| `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts` | modify | Add 7 checklist methods; extend INCLUDE with `checklist` |
| `src/infrastructure/adapters/in-memory/InMemoryTaskTemplateRepository.ts` | modify | Add `replaceItems` + `findByIdWithItems`; in-memory item arrays |
| `src/infrastructure/adapters/in-memory/InMemorySchedulingRepository.ts` | modify | Add 7 checklist methods; in-memory item arrays |
| `src/infrastructure/http/routes/taskTemplate.routes.ts` | modify | Add `PUT /:id/items`; extend router factory params |
| `src/infrastructure/http/routes/scheduling.routes.ts` | modify | Add 7 checklist sub-routes; extend router factory params |
| `src/infrastructure/http/app.ts` | modify | Wire ~15 lines: instantiate 8 new use cases, pass to both routers |
| `src/__tests__/infrastructure/scheduling-composition.test.ts` | modify | Add assertions: `POST /:id/checklist/assign-template` and `PUT /:id/checklist/order` do NOT return `TASK_NOT_FOUND` |
| `src/__tests__/application/use-cases/ReplaceTaskTemplateItems.test.ts` | new | |
| `src/__tests__/application/use-cases/AddChecklistItem.test.ts` | new | |
| `src/__tests__/application/use-cases/ToggleChecklistItem.test.ts` | new | |
| `src/__tests__/application/use-cases/UpdateChecklistItem.test.ts` | new | |
| `src/__tests__/application/use-cases/RemoveChecklistItem.test.ts` | new | |
| `src/__tests__/application/use-cases/ReorderChecklistItems.test.ts` | new | |
| `src/__tests__/application/use-cases/AssignTemplateToTask.test.ts` | new | |
| `src/__tests__/application/use-cases/ClearTaskChecklist.test.ts` | new | |
| `src/__tests__/infrastructure/checklists.routes.test.ts` | new | supertest for all 7 checklist routes + template items route |

### Frontend

| File | Action | Notes |
|------|--------|-------|
| `src/types/taskTemplate.ts` | modify | Add `TaskTemplateItem` interface; add `items?: TaskTemplateItem[]` to `TaskTemplate` |
| `src/types/scheduling.ts` | modify | Add `TaskChecklistItem` interface; add `checklist: TaskChecklistItem[]` to `ScheduledTask` |
| `src/api/taskTemplate.api.ts` | modify | Add `replaceTemplateItems(id, items)` |
| `src/api/scheduling.api.ts` | modify | Add 7 checklist API functions |
| `src/hooks/useTaskTemplates.ts` | modify | Add `useReplaceTemplateItems` mutation |
| `src/hooks/useScheduling.ts` | modify | Add `useToggleChecklistItem` (optimistic), `useAddChecklistItem`, `useUpdateChecklistItem`, `useRemoveChecklistItem`, `useReorderChecklist`, `useAssignTemplateToTask`, `useClearChecklist` |
| `src/pages/scheduling/SchedulingTemplatesPage.tsx` | modify | Expand edit modal with inline item editor |
| `src/pages/scheduling/SchedulingTemplatesPage.module.css` | modify | Styles for item editor list |
| `src/pages/scheduling/SchedulingTaskDetailPage.tsx` | modify | Replace `▣ Lista de verificación` placeholder with `<ChecklistSection>` |
| `src/pages/scheduling/SchedulingTaskDetailPage/components/ChecklistSection.tsx` | new | Interactive checklist: toggle, add, edit, remove, reorder, assign-template |
| `src/pages/scheduling/SchedulingTaskDetailPage/components/ChecklistSection.module.css` | new | |
| `src/pages/scheduling/SchedulingTaskDetailPage/components/AssignTemplateDialog.tsx` | new | Confirm + template picker dialog |
| `src/pages/scheduling/SchedulingTaskDetailPage/components/AssignTemplateDialog.module.css` | new | |
| `package.json` | modify | Add `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` |
| `src/__tests__/ChecklistSection.test.tsx` | new | Vitest + Testing Library |
| `src/__tests__/AssignTemplateDialog.test.tsx` | new | Vitest + Testing Library |
| `src/__tests__/hooks/useScheduling.checklist.test.ts` | new | Optimistic toggle rollback test |
| `src/__tests__/TemplatesPage.items.test.tsx` | new | Item editor in modal |

## TypeScript Interfaces

```ts
// src/domain/entities/checklist.ts

export interface TaskTemplateItem {
  id: string;
  templateId: string;
  text: string;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskChecklistItem {
  id: string;
  taskId: string;
  text: string;
  done: boolean;
  order: number;
  fromTemplateItemId: string | null;
  createdAt: string;
  updatedAt: string;
}
```

### Port method additions

```ts
// src/domain/ports/TaskTemplateRepository.ts (additions)

replaceItems(
  templateId: string,
  items: { text: string }[]   // order assigned server-side by array index
): Promise<TaskTemplateItem[]>;

findByIdWithItems(id: string): Promise<(TaskTemplate & { items: TaskTemplateItem[] }) | null>;
```

```ts
// src/domain/ports/SchedulingRepository.ts (additions)

getTaskWithChecklist(id: string): Promise<(ScheduledTask & { checklist: TaskChecklistItem[] }) | null>;

addChecklistItem(taskId: string, text: string): Promise<TaskChecklistItem>;

toggleChecklistItem(itemId: string): Promise<TaskChecklistItem>;

updateChecklistItem(itemId: string, text: string): Promise<TaskChecklistItem>;

removeChecklistItem(itemId: string): Promise<boolean>;

reorderChecklistItems(
  taskId: string,
  orderedIds: string[]
): Promise<TaskChecklistItem[]>;

assignTemplateToTask(
  taskId: string,
  templateId: string
): Promise<TaskChecklistItem[]>;

clearChecklist(taskId: string): Promise<void>;
```

### DTO shapes

```ts
// src/application/dto/checklists.dto.ts

import { z } from 'zod';

export const ReplaceTemplateItemsSchema = z.object({
  items: z.array(
    z.object({ text: z.string().min(1).max(500) })
  ),
});

export const AddChecklistItemSchema = z.object({
  text: z.string().min(1).max(500),
});

export const UpdateChecklistItemSchema = z.object({
  text: z.string().min(1).max(500),
});

export const ReorderChecklistSchema = z.object({
  orderedIds: z.array(z.string().min(1)).min(0),
});

export const AssignTemplateSchema = z.object({
  templateId: z.string().min(1),
});

// Toggle and Clear have no body — validated by path params only.

export type ReplaceTemplateItemsInput = z.infer<typeof ReplaceTemplateItemsSchema>;
export type AddChecklistItemInput    = z.infer<typeof AddChecklistItemSchema>;
export type UpdateChecklistItemInput = z.infer<typeof UpdateChecklistItemSchema>;
export type ReorderChecklistInput    = z.infer<typeof ReorderChecklistSchema>;
export type AssignTemplateInput      = z.infer<typeof AssignTemplateSchema>;
```

## Testing Strategy

| Layer | Scenario | Type |
|-------|----------|------|
| DTO / zod | Empty text, text > 500 chars, missing `orderedIds` | Unit (Jest, zod parse) |
| DTO / zod | `z.string().uuid()` NOT used for IDs (REQ-VAL-1) | Unit |
| Use case: `ReplaceTaskTemplateItems` | Replace empty → 3 items; Replace 3 items → 2 items (old 3rd deleted); Unknown templateId → throws `TemplateNotFoundError` | Unit (InMemory port) |
| Use case: `AddChecklistItem` | Appends with order = max+1; Unknown taskId returns null | Unit (InMemory port) |
| Use case: `ToggleChecklistItem` | false→true, true→false; Unknown itemId throws `ChecklistItemNotFoundError` | Unit (InMemory port) |
| Use case: `UpdateChecklistItem` | Updates text, preserves done+order; Unknown itemId throws | Unit (InMemory port) |
| Use case: `RemoveChecklistItem` | Removes and returns true; Unknown returns false | Unit (InMemory port) |
| Use case: `ReorderChecklistItems` | Valid orderedIds renumbers 0..N; Foreign id returns `OrderingError`; Missing id returns `OrderingError` | Unit (InMemory port) |
| Use case: `AssignTemplateToTask` | Clears existing + clones template items with `fromTemplateItemId` set; Empty template clears; Unknown template throws `TemplateNotFoundError` | Unit (InMemory port) |
| Use case: `ClearTaskChecklist` | Removes all items; Empty task no-ops | Unit (InMemory port) |
| Routes: taskTemplate | `PUT /:id/items` 200 with items; 400 on invalid text; 404 on missing template | supertest (InMemory repos) |
| Routes: scheduling checklist | All 7 sub-routes return correct status codes; unknown item/task return correct error codes | supertest (InMemory repos) |
| Routes: auth | All checklist routes return 401 without cookie | supertest |
| Composition test | `POST /api/scheduling/:id/checklist/assign-template` not shadowed by `/:id` catch-all | supertest (extended existing file) |
| Composition test | `PUT /api/scheduling/:id/checklist/order` not shadowed by `/:id` PUT | supertest (extended existing file) |
| Frontend: `ChecklistSection` | Renders items; checkbox click fires `useToggleChecklistItem`; optimistic flip + rollback on error | Vitest + Testing Library (mock API layer) |
| Frontend: `AssignTemplateDialog` | Renders template list; confirm fires `useAssignTemplateToTask`; cancel does not mutate | Vitest + Testing Library |
| Frontend: optimistic toggle | `onMutate` snapshot applied; `onError` restores prior state | Vitest (mock `axios`/`fetch`, not `queryClient`) |
| Frontend: `SchedulingTemplatesPage` item editor | Add item, save calls `replaceTemplateItems`; drag triggers reorder; delete removes item from list | Vitest + Testing Library |

## Migration / Rollout

### Up SQL

```sql
-- Migration: 20260520050000_scheduling_checklists
-- DDL only — no data to backfill

CREATE TABLE "TaskTemplateItem" (
  "id"         TEXT         NOT NULL,
  "templateId" TEXT         NOT NULL,
  "text"       TEXT         NOT NULL,
  "order"      INTEGER      NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TaskTemplateItem_pkey"          PRIMARY KEY ("id"),
  CONSTRAINT "TaskTemplateItem_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "TaskTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "TaskTemplateItem_templateId_order_idx"
  ON "TaskTemplateItem"("templateId", "order");

CREATE TABLE "TaskChecklistItem" (
  "id"                 TEXT         NOT NULL,
  "taskId"             TEXT         NOT NULL,
  "text"               TEXT         NOT NULL,
  "done"               BOOLEAN      NOT NULL DEFAULT FALSE,
  "order"              INTEGER      NOT NULL,
  "fromTemplateItemId" TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TaskChecklistItem_pkey"   PRIMARY KEY ("id"),
  CONSTRAINT "TaskChecklistItem_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "ScheduledTask"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TaskChecklistItem_fromTemplateItemId_fkey"
    FOREIGN KEY ("fromTemplateItemId") REFERENCES "TaskTemplateItem"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "TaskChecklistItem_taskId_order_idx"
  ON "TaskChecklistItem"("taskId", "order");
```

### Down SQL (manual rollback)

```sql
DROP TABLE IF EXISTS "TaskChecklistItem";
DROP TABLE IF EXISTS "TaskTemplateItem";
```

### Rollout order

1. Run migration on target database (`npm run prisma:migrate`).
2. Deploy backend — new endpoints live, existing endpoints unaffected (additive schema, `checklist` defaults to `[]`).
3. Old frontend keeps working (it ignores unknown fields).
4. Deploy frontend — `ChecklistSection` and template item editor become active.
5. Smoke E2E from `tasks.md` phase 14.

## Open Questions

None. All design decisions are resolved from proposal + spec.
