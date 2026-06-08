# Proposal: Reconcile Page + Per-Task/Batch Reconcile (#35, Part 2)

> **Part 1 SHIPPED** — data migration `20260610000000_reset_burned_audit_attempts` (BE PR #81) already re-armed #34's audit rescue by resetting burned `auditAttempts`. This proposal covers **Part 2 only**: the reconcile page and its endpoints.

## Intent

Operators can trigger the **batch** closure backfill (202, ~78 tasks) but cannot reconcile **one** in-flight task on demand, nor even see which tasks are stuck in `registered_in_iclass`. They need a page that lists in-flight tasks and lets them reconcile a single task synchronously (fast feedback) or all of them (existing batch).

## Scope

### In Scope
- `ReconcileTaskClosure(taskId)` use case — synchronous, shares a private `reconcileOne` helper extracted from `BackfillClosedServiceOrders` (batch behavior unchanged).
- `ListInFlightTasks` use case → DTO list (id, sequenceNumber, title, customerName, customerCode, iclassOrderCode).
- BE routes: `GET /closure/in-flight` (200 list) + `POST /closure/reconcile/:taskId` (200 sync, counts). Both gated `requireIClassManage`.
- FE: `ReconcileInFlightPage` + `InFlightTasksTable` (per-row "Reconciliar" 200-sync, header "Reconciliar todas" reusing batch 202), hooks `useInFlightTasks`/`useReconcileTask`, route gated `iclass.manage`, link from `IClassClosureFlagBody`.

### Out of Scope
- Part 1 audit reset migration (shipped, PR #81).
- Making 1x1 async or changing the batch (already async, #32/#33).

## Capabilities

### New Capabilities
- `iclass-closure-reconcile`: per-task synchronous reconcile + in-flight task listing endpoint and FE page.

### Modified Capabilities
- None (batch backfill behavior is preserved; `reconcileOne` is an internal refactor, not a spec change).

## Approach

Extract the per-task loop body of `BackfillClosedServiceOrders` into `reconcileOne(task, begin, now, counts)` (query IClass by `serviceOrderCode = sequenceNumber`, `processSummary` if closed). New `ReconcileTaskClosure` fetches the task by id, calls `reconcileOne` once, returns 200 with counts. `ListInFlightTasks` wraps `listTasksInIClassStage('registered_in_iclass')` → DTO. Thread both into `createIClassClosureRouter`. FE mirrors the #31/#32 `ClosurePendingPage` precedent.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `application/use-cases/BackfillClosedServiceOrders.ts` | Modified | Extract `reconcileOne` (DRY) |
| `application/use-cases/ReconcileTaskClosure.ts` | New | 1x1 sync reconcile |
| `application/use-cases/ListInFlightTasks.ts` | New | In-flight DTO list |
| `infrastructure/http/routes/iclass-closure.routes.ts` | Modified | 2 new routes |
| `infrastructure/http/app.ts` | Modified | Wire new deps |
| FE `ReconcileInFlightPage` / `InFlightTasksTable` / hooks / api / `App.tsx` / `IClassClosureFlagBody` | New/Modified | Page mirroring `ClosurePendingPage` |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `getTaskById` missing on `SchedulingRepository` | Med | Confirm in design; add minimal `getTaskById(id)` if absent |
| SO older than 29-day lookback → not found | Med | Surface "no se encontró cierre reciente" message |
| Returning raw `ScheduledTask` | Low | DTO at all boundaries (hard rule) |

## Rollback Plan

Pure additive. Revert the FE route/link + BE routes to hide the feature; keep `reconcileOne` (internal refactor, behavior-equivalent) or revert it with `BackfillClosedServiceOrders`. No DB/migration changes in Part 2.

## Dependencies

- Part 1 migration (shipped). `listTasksInIClassStage`, `processSummary`, `BackfillScheduler` — all existing.

## Success Criteria

- [ ] `GET /closure/in-flight` returns in-flight tasks as DTOs (gated iclass.manage).
- [ ] `POST /closure/reconcile/:taskId` reconciles one task synchronously, returns 200 + counts; a closed task drops out of the in-flight list on refetch.
- [ ] "Reconciliar todas" reuses the existing batch (202).
- [ ] Batch backfill behavior unchanged after `reconcileOne` extraction.
