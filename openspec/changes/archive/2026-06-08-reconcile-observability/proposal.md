# Proposal: Reconcile Observability (#37)

## Intent

Two small, independent gaps left by #35's reconcile work:

1. **BE blind spot.** `BackfillClosedServiceOrders.reconcileOne` (line ~92) has `catch { counts.failed++; }` — it swallows the error WITHOUT binding it or logging. While diagnosing #36, the reconcile's `failed=6` forced manual archaeology (querying IClass + prod DB) to find the cause; failures turned out transient (an OS with identical `tipoOs`+`motivo` succeeded while another failed), but with zero logging we couldn't tell. Every per-task failure currently demands deep investigation. The catch is shared by BOTH the batch loop AND the 1x1 `ReconcileTaskClosure`.
2. **FE blind spot.** The Reconcile page (#35) lists in-flight tasks but never shows their COUNT. Operators can't see at a glance how many OS sit in "Registrado en IClass".

## Scope

### In Scope
- BE: capture the error in `reconcileOne`'s catch and log it via `console.warn('[backfill] task ${task.sequenceNumber} FAILED: ${(err as Error).message}')`, matching existing closure logging (`[iclass-closure]`, `[backfill-scheduler]`). Benefits batch + 1x1.
- FE: surface the in-flight count (badge / small message) on the Reconcile page, sourced from the existing in-flight list length.

### Out of Scope
- Surfacing the failure reason in the 1x1 HTTP response or a richer FE error state (the 1x1 still shows "no se encontró cierre reciente" even on failure — known minor gap, possible future).
- Changing the `failed` counting, the per-task isolation, or #33's isolation behavior.
- Any new endpoint (count comes from the existing list).

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `iclass-closure-reconcile`: add an observability requirement — per-task reconcile failures MUST be logged with the task sequence + error message (isolation unchanged); the Reconcile page MUST display the in-flight task count.

## Approach

- **BE**: bind the error in the existing catch (`catch (err)`) and add a single `console.warn` line BEFORE `counts.failed++`. No logger seam introduced — `console.warn` matches the existing closure logging norm. Keep isolation: a per-task failure still does NOT abort the batch. Minimal diff.
- **FE**: render a count (badge or header text, e.g. "27 OS en Registrado en IClass") in `InFlightTasksTable` / `ReconcileInFlightPage`, derived from `items.length` (already in `useInFlightTasks`). No new data fetch. impeccable polish on placement/styling.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/application/use-cases/BackfillClosedServiceOrders.ts` | Modified | Bind + log error in `reconcileOne` catch |
| `src/__tests__/application/BackfillClosedServiceOrders.test.ts` | Modified | Assert warn called on per-task failure; isolation preserved |
| `ipnext-frontend/.../settings/InFlightTasksTable.tsx` | Modified | Surface in-flight count badge/message |
| `ipnext-frontend/.../ReconcileInFlightPage.tsx` | Modified (maybe) | Host the count if placed in page header |
| FE test (`InFlightTasksTable.test.tsx`) | Modified | Assert count renders from list length |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Log noise on large transient-failure batches | Low | One warn per failed task; matches existing closure log volume |
| FE count drifts from list (pagination/empty) | Low | Source strictly from rendered `items.length`; hide/zero on empty |

## Rollback Plan

Both changes are additive and isolated. Revert the BE one-liner (remove the warn, restore `catch {`) and the FE count element independently — no schema, no API, no migration involved.

## Dependencies

- Builds on #35 (`reconcile-page-and-audit-reset`, SHIPPED): `reconcileOne`, `ReconcileTaskClosure`, `useInFlightTasks`, the Reconcile page.

## Success Criteria

- [ ] A per-task reconcile failure emits a `[backfill] task <seq> FAILED: <msg>` warn (batch + 1x1) without aborting the run.
- [ ] `failed` counting and per-task isolation are unchanged.
- [ ] The Reconcile page shows the count of in-flight tasks, equal to the list length.
- [ ] BE + FE tests green (strict TDD).
