# Proposal — scheduling-checklists

## Intent

Replicate Splynx's task checklist feature end-to-end. Today `TaskTemplate` is a bare record (id/name/description/category) and `ScheduledTask` has no per-task checklist; the task detail page in the frontend already renders a `▣ Lista de verificación` placeholder section (change 4) that needs to be wired to real data. This change enriches `TaskTemplate` with ordered items, gives every `ScheduledTask` an ordered, toggleable checklist, and adds an "assign template → clone items" operation. The frontend gains a full item editor inside `SchedulingTemplatesPage` and replaces the placeholder in `SchedulingTaskDetailPage` with an interactive checklist (load template, clear, add ad-hoc, toggle, reorder, edit in place, remove). This is change 5 of a 6-change Splynx parity initiative.

## Scope IN

### Backend (this repo)

- Prisma models `TaskTemplateItem` and `TaskChecklistItem` (no `schema.prisma` edits in planning — flagged for change-apply).
- Migration `20260520050000_scheduling_checklists` — DDL only (no backfill needed; new tables).
- Domain entities `TaskTemplateItem`, `TaskChecklistItem`. Extend `TaskTemplate` with optional `items?: TaskTemplateItem[]`. Extend `ScheduledTask` with `checklist: TaskChecklistItem[]`.
- Domain errors: `TemplateItemNotFoundError`, `ChecklistItemNotFoundError`, `TemplateNotFoundError` (reuse existing for assign-template flow).
- Port extensions:
  - `TaskTemplateRepository`: `replaceItems(templateId, items: {text, order}[]): Promise<TaskTemplateItem[]>`; `findByIdWithItems(id)`.
  - `SchedulingRepository`: `getTaskWithChecklist(id)`, `addChecklistItem`, `updateChecklistItem`, `toggleChecklistItem`, `removeChecklistItem`, `reorderChecklistItems(taskId, orderedIds: string[])`, `assignTemplateToTask(taskId, templateId)`, `clearChecklist(taskId)`.
- Use cases (under `application/use-cases/`): `ReplaceTaskTemplateItems`, `AddChecklistItem`, `UpdateChecklistItem`, `ToggleChecklistItem`, `RemoveChecklistItem`, `ReorderChecklistItems`, `AssignTemplateToTask`, `ClearTaskChecklist`.
- DTOs: new file `application/dto/checklists.dto.ts` with zod schemas — `ReplaceTemplateItemsSchema`, `AddChecklistItemSchema`, `UpdateChecklistItemSchema`, `ToggleChecklistItemSchema`, `ReorderChecklistSchema`, `AssignTemplateSchema`.
- Routes:
  - `taskTemplate.routes.ts`: extend with `PUT /:id/items` (replace-set), and ensure `GET /:id` returns items.
  - `scheduling.routes.ts`: extend with `POST /:id/checklist`, `PATCH /:id/checklist/:itemId`, `PATCH /:id/checklist/:itemId/toggle`, `DELETE /:id/checklist/:itemId`, `PUT /:id/checklist/order`, `POST /:id/checklist/assign-template`, `DELETE /:id/checklist`.
- `app.ts` wiring (~15 lines) — flagged.
- In-memory + Prisma adapters updated.
- Composition test `scheduling-composition.test.ts` extended to cover at least `POST /:id/checklist/assign-template` and `PUT /:id/checklist/order` (sub-routes that could be shadowed by `/:id`).
- Unit + route tests under `src/__tests__/`.

### Frontend (sibling repo)

- Types: `taskTemplate.ts` adds `items?: TaskTemplateItem[]`. `scheduling.ts` adds `checklist: TaskChecklistItem[]`.
- API wrappers in `src/api/taskTemplate.api.ts` and `src/api/scheduling.api.ts`.
- Hooks in `useTaskTemplates.ts` and `useScheduling.ts`: `useReplaceTemplateItems`, `useAddChecklistItem`, `useToggleChecklistItem` (optimistic), `useUpdateChecklistItem`, `useRemoveChecklistItem`, `useReorderChecklist`, `useAssignTemplateToTask`, `useClearChecklist`.
- `SchedulingTemplatesPage.tsx`: item list editor inside the existing edit modal — add/edit/remove, drag-reorder via `@dnd-kit/core` + `@dnd-kit/sortable`.
- `SchedulingTaskDetailPage.tsx`: replace `▣ Lista de verificación` placeholder with an interactive checklist (checkbox toggle with optimistic UI + rollback, add inline, edit in place, drag-reorder, "Cargar lista" with template picker, "Limpiar lista" with confirm).
- Vitest unit tests for both pages.

## Scope OUT (deferred to change 6)

- Kanban view, multi-select filters, partial saves of checklists across navigation.
- Auth fix on `projects.routes.ts` (already done opportunistically in change 2).
- Per-item assignees or due dates (not in Splynx snapshot).
- Pasting markdown bullets to create multiple items at once (nice-to-have, not in screenshot).

## Capability

Propose new capability spec `scheduling-checklists` (separate concern: items/ordering/cloning lifecycle is distinct from "scheduling tasks" core and from "task templates" CRUD). This keeps the existing `scheduling/spec.md` and the implicit `task-templates` surface clean.

## Approach (numbered)

1. **Schema**: add `TaskTemplateItem` and `TaskChecklistItem` Prisma models with `(parentId, order)` composite indexes. CASCADE on parent delete. `fromTemplateItemId` on checklist items is `SET NULL` so deleting the source template item does not delete the checklist copy.
2. **Domain**: pure entities + ports. No infra leakage.
3. **Application**: thin use cases that validate FKs and delegate to ports. `AssignTemplateToTask` is the only orchestration-heavy one (load template-with-items, clear current checklist, clone items preserving order, set `fromTemplateItemId`).
4. **Infrastructure — Prisma adapter**: items are loaded via Prisma `include` (mirrors `PrismaSchedulingRepository`'s watchers pattern). Reorder is a transaction that bumps `order` per id; replace-set runs `deleteMany` + `createMany` in a transaction.
5. **Infrastructure — InMemory adapter**: in-memory arrays; sort by `order` on read; renumber on reorder.
6. **Routes**: all authed; URL convention follows `scheduling.routes.ts` REST style. Document URL table inside `design.md`.
7. **Composition test**: extend existing test to assert `POST /api/scheduling/<id>/checklist/assign-template` and `PUT /api/scheduling/<id>/checklist/order` do NOT collide with `GET /:id` catch-all and do NOT collide with workflows mount.
8. **Wiring** in `app.ts`: instantiate new use cases, pass to both routers.
9. **Frontend** — first extend types + hooks (compile-driven), then templates editor (lower risk), then task detail page (higher UX risk).
10. **Optimistic toggle**: snapshot `checklist` array on mutate, replace optimistically, rollback on 5xx; 4xx surfaces a toast and refetches.
11. **Drag-reorder**: `@dnd-kit/sortable` with keyboard sensors enabled (accessibility).
12. **Smoke E2E**: curl + Playwright walkthrough (create template→3 items→create task→assign template→toggle→add ad-hoc→reorder→delete→reload→verify persisted).

## Affected Areas

### Backend
- `prisma/schema.prisma` (apply phase only)
- `prisma/migrations/20260520050000_scheduling_checklists/migration.sql` (new)
- `src/domain/entities/taskTemplate.ts`, `taskTemplateItem.ts` (new), `scheduling.ts`, `taskChecklistItem.ts` (new)
- `src/domain/errors/scheduling.ts` (extend)
- `src/domain/ports/TaskTemplateRepository.ts`, `SchedulingRepository.ts`
- `src/application/dto/checklists.dto.ts` (new)
- `src/application/use-cases/*` (8 new files)
- `src/infrastructure/adapters/prisma/PrismaTaskTemplateRepository.ts`, `PrismaSchedulingRepository.ts`
- `src/infrastructure/adapters/in-memory/InMemoryTaskTemplateRepository.ts`, `InMemorySchedulingRepository.ts`
- `src/infrastructure/http/routes/taskTemplate.routes.ts`, `scheduling.routes.ts`
- `src/infrastructure/http/app.ts` ⚠
- `src/__tests__/application/*`, `src/__tests__/infrastructure/*`, `src/__tests__/infrastructure/scheduling-composition.test.ts`

### Frontend
- `src/types/taskTemplate.ts`, `src/types/scheduling.ts`
- `src/api/taskTemplate.api.ts`, `src/api/scheduling.api.ts`
- `src/hooks/useTaskTemplates.ts`, `src/hooks/useScheduling.ts`
- `src/pages/scheduling/SchedulingTemplatesPage.tsx` + module CSS
- `src/pages/scheduling/SchedulingTaskDetailPage.tsx` + module CSS
- `src/components/scheduling/ChecklistEditor.tsx` (new — shared by templates page)
- `src/components/scheduling/TaskChecklist.tsx` (new — task detail interactive)
- Vitest specs alongside.
- `package.json`: add `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`.

## Risks

1. **Composition shadowing**: new `/api/scheduling/:id/checklist/...` sub-routes interact with the `/:id` catch-all. Mitigation: explicit composition tests.
2. **Optimistic toggle race**: rapid toggles on the same item can yield out-of-order responses. Mitigation: dedupe by `itemId` in mutation queue + invalidate on settle.
3. **Reorder concurrency**: two users dragging simultaneously can corrupt `order`. Acceptable for v1 (last-write-wins). Documented in spec.
4. **Replace semantics of `AssignTemplateToTask`**: destroys current checklist — user must confirm in UI. If they cancel after the API call, state is already gone. Mitigation: confirm BEFORE call.
5. **Drag library bundle size**: `@dnd-kit/*` adds ~12 KB gzip. Acceptable; alternative is `react-beautiful-dnd` (~30 KB and unmaintained for React 18).
6. **Prisma `fromTemplateItemId` SET NULL**: deleting a template item leaves orphaned checklist copies with null reference. Intended (don't lose user work) but spec must call it out.

## Frontend Coordination

The frontend repo must land in lockstep. Order:

1. Backend PR merges first (additive — old frontend keeps working because checklist defaults to `[]`).
2. Frontend PR merges next, consuming new endpoints.
3. Verify smoke E2E against `npm run dev` in both repos before declaring done.

## Rollback Plan

Migration is purely additive — no data loss on rollback.

```sql
-- Down (manual rollback for 20260520050000_scheduling_checklists)
DROP TABLE IF EXISTS "TaskChecklistItem";
DROP TABLE IF EXISTS "TaskTemplateItem";
```

Code rollback: revert the merge commit on both repos.

## Dependencies

- Changes 1–4 merged (Workflow, Stage, ScheduledTask enrichment, task detail page placeholder).
- No new infra (no Redis, no queues).
- Frontend depends on `@dnd-kit/*` (new npm packages — flag at `npm install` time).

## Success Criteria

- `npm test` green in backend (Jest) and frontend (Vitest).
- `tsc --noEmit` green in both repos.
- Composition test covers checklist sub-routes.
- Smoke E2E (curl + Playwright) passes the 10-step script in `tasks.md`.
- After reload, checklist state persists exactly.
- Toggling an item is visually instant (<16 ms perceived); a forced 5xx rolls back the checkbox.
- Keyboard-only user can reorder via `@dnd-kit` keyboard sensor.
