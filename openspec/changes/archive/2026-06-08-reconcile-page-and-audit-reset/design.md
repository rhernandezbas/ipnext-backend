# Design: Reconcile Page + Per-Task/Batch Reconcile (#35, Part 2)

## Technical Approach

Extract the per-task loop body of `BackfillClosedServiceOrders.execute()` into a private
`reconcileOne(task, begin, now, counts)` so the batch loop and a new synchronous
`ReconcileTaskClosure(taskId)` share byte-identical behavior. Add a thin `ListInFlightTasks`
use case that maps `listTasksInIClassStage('registered_in_iclass')` → `InFlightTaskDto`.
Expose two routes (`GET /closure/in-flight` 200, `POST /closure/reconcile/:taskId` 200 sync)
through the existing `createIClassClosureRouter`. FE mirrors the `ClosurePendingPage` precedent.

## Open Questions — RESOLVED

- **`getTaskById`?** No new method. `SchedulingRepository.getTask(id)` already exists
  (`SchedulingRepository.ts:37`) on the port and both adapters. Use it.
- **Not-found error?** `TaskNotFoundError` already exists (`domain/errors/scheduling.ts:12`,
  a `DomainError`) and the global error handler maps `DomainError` → 404. Reuse it.

## Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| DRY the per-task body | Private method `reconcileOne` ON `BackfillClosedServiceOrders`, injected into `ReconcileTaskClosure` via constructor | Keeps the throttle/loop owner unchanged; single-task use case reuses the exact closed-SO query + `processSummary` without duplicating it. A free module fn would need the same deps passed twice. |
| 1x1 sync vs 202 | Synchronous, returns 200 + counts | One `iclass.listServiceOrders` call, no throttle loop, no Ollama on hot path (audit re-fires via reprocess scheduler). Batch keeps 202 (loops ~78 tasks @350ms → timeout risk). |
| Task fetch | `scheduling.getTask(taskId)` | Already on the port; no new method. |
| Not found | `throw new TaskNotFoundError(taskId)` → 404 | Existing error + handler; no new mapping. |
| In-flight DTO | New `InFlightTaskDto` + mapper | CLAUDE.md hard rule: never leak raw `ScheduledTask`. |
| Stage validation | Reconcile whatever `getTask` returns (no stage guard) | `processSummary` is idempotent and only transitions terminal SOs; a non-in-flight task simply yields `skippedNotClosed`/no-op. Avoids a spurious 409. |

## Data Flow

    GET /closure/in-flight
      → ListInFlightTasks.execute()
        → scheduling.listTasksInIClassStage('registered_in_iclass')  ScheduledTask[]
        → map → InFlightTaskDto[]                                    200 { items }

    POST /closure/reconcile/:taskId
      → ReconcileTaskClosure.execute(taskId)
        → scheduling.getTask(taskId)            null → TaskNotFoundError → 404
        → backfill.reconcileOne(task, begin, now, counts)
            → iclass.listServiceOrders({ serviceOrderCode: task.sequenceNumber, begin, now })
            → for each summary: ingest.processSummary(s, counts)
        → 200 IngestClosedCounts

## Refactor shape (`reconcileOne`)

```ts
// BackfillClosedServiceOrders — extracted, called by the batch loop AND ReconcileTaskClosure
async reconcileOne(task: ScheduledTask, begin: Date, now: Date, counts: IngestClosedCounts): Promise<void> {
  try {
    const summaries = await this.iclass.listServiceOrders({
      updatedDateBegin: begin, updatedDateEnd: now,
      serviceOrderCode: String(task.sequenceNumber),
    });
    for (const s of summaries) await this.ingest.processSummary(s, counts);
  } catch {
    counts.failed++;   // task-level failure; does not abort the caller
  }
}
```
The batch `execute()` loop becomes `await this.reconcileOne(task, begin, now, counts); await this.sleep(this.throttleMs);`.
`ReconcileTaskClosure` receives the `BackfillClosedServiceOrders` instance (its `now`/`lookbackDays`
are the source of truth for `begin`) and calls `reconcileOne` once, no sleep.

## Interfaces / Contracts

```ts
// application/dto/iclassClosure.dto.ts (extend)
export interface InFlightTaskDto {
  id: string;
  sequenceNumber: number;
  title: string;
  customerName: string | null;
  customerCode: string | null;
  iclassOrderCode: string | null;
}
// GET /closure/in-flight        → 200 { items: InFlightTaskDto[] }
// POST /closure/reconcile/:id   → 200 IngestClosedCounts  | 404 TaskNotFoundError
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `application/use-cases/BackfillClosedServiceOrders.ts` | Modify | Extract `reconcileOne`; `execute` calls it. Behavior-equivalent. |
| `application/use-cases/ReconcileTaskClosure.ts` | Create | `execute(taskId)`: getTask→404, `reconcileOne` once → counts. |
| `application/use-cases/ListInFlightTasks.ts` | Create | Wraps `listTasksInIClassStage` → `InFlightTaskDto[]`. |
| `application/dto/iclassClosure.dto.ts` | Modify | `InFlightTaskDto` + `toInFlightTaskDto`. |
| `infrastructure/http/routes/iclass-closure.routes.ts` | Modify | 2 routes (gated `requireIClassManage`); 2 new ctor params. |
| `infrastructure/http/app.ts` | Modify | Construct + inject both use cases (~1250). |
| FE `pages/scheduling/ReconcileInFlightPage.tsx` | Create | Mirrors `ClosurePendingPage`; `iclass.manage`. |
| FE `pages/scheduling/settings/InFlightTasksTable.tsx` | Create | Row per task + per-row "Reconciliar" + header "Reconciliar todas". |
| FE `hooks/useIClassClosure.ts` | Modify | `useInFlightTasks`, `useReconcileTask` (invalidate in-flight on success). |
| FE `api/iclassClosure.api.ts` | Modify | `inFlightList()`, `reconcileTask(id)`; `InFlightTask`/`InFlightTaskList` types. |
| FE `App.tsx` | Modify | Lazy import + `<Route path="iclass/closure/reconcile">` gated `iclass.manage`. |
| FE `pages/scheduling/settings/IClassClosureFlagBody.tsx` | Modify | Link to the reconcile page near the backfill card. |

## FE behavior notes

- Per-row "Reconciliar" → `useReconcileTask` (200) → invalidate `['iclassClosure','inFlight']`;
  if the task closed it drops from the refetched list. Inline result shows counts; when
  `mirrored === 0 && transitioned === 0` (i.e. `skippedNotClosed`) show
  "no se encontró cierre reciente".
- Header "Reconciliar todas" reuses `useRunClosureBackfill` (202).
- `useInFlightTasks`: TanStack query, optional stop-at-empty `refetchInterval` mirroring `usePendingList`.

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Unit | `reconcileOne` parity + `ReconcileTaskClosure` (closed→transitioned, open→skippedNotClosed, missing→404) | Reuse `BackfillClosedServiceOrders.test.ts` in-memory rig in new `ReconcileTaskClosure.test.ts`. |
| Unit | `ListInFlightTasks` maps to DTO, no raw entity | In-memory scheduling repo seeded with one in-flight task. |
| Integration | `GET /closure/in-flight` 200 list; `POST /closure/reconcile/:id` 200 + 404; `requireIClassManage` gate | Extend `iclass-closure.routes.test.ts` (supertest). |
| Integration | Batch backfill unchanged | Existing `BackfillClosedServiceOrders.test.ts` stays green. |
| FE | Page render, table rows/empty, per-row reconcile, link | New `ReconcileInFlightPage.test.tsx` + `InFlightTasksTable.test.tsx` mirroring `ClosurePendingPage`/`ClosureProgressTable` templates. |

## Migration / Rollout

No migration in Part 2 (Part 1 shipped, PR #81). Pure additive; rollback = revert FE route/link
+ BE routes. `reconcileOne` extraction is behavior-equivalent and can stay.
