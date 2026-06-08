# Tasks: Async Closure Side-Effects Reprocess (#23)

## Batch A — Backend

### Phase A1: Foundation — use case + scheduler core

- [x] A1.1 RED: write failing test for `GetPendingSideEffectsCount` in `src/__tests__/application/GetPendingSideEffectsCount.test.ts` — covers pending>0 (REQ-PENDING-COUNT-1 happy path) and pending=0
- [x] A1.2 GREEN: create `src/application/use-cases/GetPendingSideEffectsCount.ts` — wraps `closedServiceOrderRepo.listPendingSideEffects(3).length`, returns `{ pending: number }`
- [x] A1.3 RED: extend `src/__tests__/infrastructure/TaskAutocompleteScheduler.test.ts` — add cases: `triggerNow` queued (REQ-TRIGGER-1), `triggerNow` already-running (inFlight=true), `triggerNow` flag-disabled, cron path unchanged (REQ-SCHED-1)
- [x] A1.4 GREEN: modify `src/infrastructure/scheduling/TaskAutocompleteScheduler.ts` — add `flags` + `manualReprocess` constructor deps; parameterize `runOnce(reprocess = this.reprocess)`; implement `async triggerNow(): Promise<TriggerResult>` with inFlight pre-check, flag read, `void runOnce(this.manualReprocess)`
- [x] A1.5 REFACTOR: update `src/infrastructure/scheduling/bootstrapTaskAutocomplete.ts` — build second `ReprocessClosureSideEffects` bound to `iclass-closure-reprocess`; pass `manualReprocess` + `flags` to scheduler constructor

### Phase A2: Route + wiring

- [x] A2.1 RED: extend `src/__tests__/infrastructure/iclass-closure.routes.test.ts` — update router factory call to new signature; add `POST /reprocess` → 202 queued/already-running/flag-disabled (REQ-REPROCESS-1); `GET /reprocess/pending-count` → 200 {pending} (REQ-PENDING-COUNT-1); null scheduler → 503; auth 401 on both routes
- [x] A2.2 GREEN: modify `src/infrastructure/http/routes/iclass-closure.routes.ts` — replace `reprocessClosure` param with `scheduler` + `getPendingCount`; `POST /reprocess` calls `scheduler.triggerNow()` → 202; `GET /reprocess/pending-count` calls use case → 200; null scheduler → 503 `{ reason: 'unavailable' }`
- [x] A2.3 GREEN: modify `src/infrastructure/http/app.ts` — `createApp(taskAutocomplete?: TaskAutocompleteScheduler)`; build `GetPendingSideEffectsCount`; pass both into `createIClassClosureRouter`
- [x] A2.4 GREEN: modify `src/main.ts` — move `bootstrapTaskAutocomplete()` above `createApp()`; pass instance into `createApp(scheduler)`
- [x] A2.5 VERIFY: `npx tsc --noEmit` passes; `npx jest --runInBand` green

## Batch B — Frontend

### Phase B1: API + hooks

- [x] B1.1 RED: write failing tests for `useReprocessClosure` — 202 queued:true shows "encolado" banner; queued:false/already-running shows "en curso"; button disabled while pending>0
- [x] B1.2 GREEN: modify `src/api/iclassClosure.api.ts` — `reprocess()` returns `ClosureReprocessQueued`; add `pendingCount()` → `ClosurePendingCount` (`GET /reprocess/pending-count`)
- [x] B1.3 GREEN: modify `src/hooks/useIClassClosure.ts` — `useReprocessClosure` handles queued union result; add `usePendingCount({ refetchInterval: 5000 })` stopping at 0
- [x] B1.4 RED: write failing test for `usePendingCount` — polls until pending=0 then stops refetch (REQ-PENDING-COUNT-1 FE)
- [x] B1.5 GREEN: wire `usePendingCount` refetch stop condition (set `refetchInterval: pending > 0 ? 5000 : false`)

### Phase B2: Component

- [x] B2.1 RED: write failing test for `IClassClosureFlagBody` — banner "encolado" on queued:true; banner "en curso" on already-running; button disabled when pending>0 or queued:true
- [x] B2.2 GREEN: modify `src/pages/scheduling/settings/IClassClosureFlagBody.tsx` — render queued banner; show decrementing pending count; disable "Reprocesar" button while pending>0 or queued
- [x] B2.3 VERIFY: `npx vitest run` green; `npm run typecheck` passes

## Coverage Map — 13 Spec Scenarios

| Scenario | Task(s) |
|---|---|
| Reprocess dispatched successfully | A2.1, A2.2 |
| Already in flight | A1.3, A1.4, A2.1 |
| Manual flag OFF | A1.3, A1.4, A2.1 |
| Manual reprocess with cron flag OFF | A1.3, A1.4 |
| Unauthenticated reprocess | A2.1 |
| Pending SOs exist (happy path) | A1.1, A1.2, A2.1 |
| No pending SOs | A1.1, A1.2 |
| Unauthenticated pending-count | A2.1 |
| triggerNow returns before background work | A1.3, A1.4 |
| triggerNow while in flight | A1.3, A1.4 |
| Cron tick runs when flag ON | A1.3, A1.4 |
| Cron tick skipped when already running | A1.3, A1.4 |
| Cron tick with flag OFF | A1.3, A1.4 |
