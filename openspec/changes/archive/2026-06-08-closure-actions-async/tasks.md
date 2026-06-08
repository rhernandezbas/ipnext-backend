# Tasks: Closure Actions Async (#32)

## Batch A — Backend

### Phase A1: BackfillScheduler (TDD)

- [x] A1.1 RED — Create `src/__tests__/infrastructure/BackfillScheduler.test.ts`: test `triggerNow()` returns `{queued:true}` when idle (REQ-BACKFILL-SCHEDULER-1 / scenario: triggerNow returns before background work finishes)
- [x] A1.2 RED — Add test: re-entrancy guard returns `{queued:false, reason:'already-running'}` when `inFlight` is true (scenario: triggerNow re-entrancy guard)
- [x] A1.3 RED — Add test: lock not acquired (held by another instance) → `runOnce` skips execute (scenario: advisory lock key is distinct)
- [x] A1.4 GREEN — Create `src/infrastructure/scheduling/BackfillScheduler.ts`: `BackfillTriggerResult` type, `inFlight` guard, `PgAdvisoryLock('iclass-closure-backfill')`, `triggerNow()` fire-and-forget `void runOnce()`. No `start()`/`setInterval`.
- [x] A1.5 REFACTOR — Verify `npx jest BackfillScheduler` green; confirm lock key `'iclass-closure-backfill'` does not collide with `'task-autocomplete'` or `'iclass-closed'`.

### Phase A2: Bootstrap + Wiring

- [x] A2.1 Create `src/infrastructure/scheduling/bootstrapBackfill.ts`: builds `BackfillClosedServiceOrders` + `BackfillScheduler`; returns `null` when IClass creds missing (mirrors `bootstrapTaskAutocomplete.ts`).
- [x] A2.2 Modify `src/main.ts`: add async IIFE; `await bootstrapBackfill(...)` before `createApp`; pass result into `createApp`. No `.start()` call.
- [x] A2.3 Modify `src/infrastructure/http/app.ts` (~line 1255): add `backfillScheduler: BackfillScheduler | null` param to `createApp`; pass it into `createIClassClosureRouter` replacing the inline `new BackfillClosedServiceOrders(...)`.

### Phase A3: Route — backfill 202/503 (TDD)

- [x] A3.1 RED — Modify `src/__tests__/infrastructure/iclass-closure.routes.test.ts`: update existing backfill test to expect `202 {queued:true}` (was 200) (scenario: backfill dispatched successfully)
- [x] A3.2 RED — Add test: second call while in-flight → `202 {queued:false, reason:'already-running'}` (scenario: backfill while a run is already in flight)
- [x] A3.3 RED — Add test: scheduler null → `503 {reason:'unavailable'}` (scenario: backfill when scheduler not available)
- [x] A3.4 RED — Add test: no auth token → `401` (scenario: unauthenticated backfill request)
- [x] A3.5 GREEN — Modify `src/infrastructure/http/routes/iclass-closure.routes.ts`: replace `backfillClosedOrders: BackfillClosedServiceOrders` param with `backfillScheduler: BackfillScheduler | null` (same positional slot); route: `if (!backfillScheduler) 503; else 202 await triggerNow()`.
- [x] A3.6 REFACTOR — Run `npx jest iclass-closure.routes --runInBand` + `npx tsc --noEmit`; all 4 backfill scenarios green.

---

## Batch B — Frontend

### Phase B1: API + Hook (TDD)

- [x] B1.1 RED — Write test for `useRunClosureBackfill` (or `useBackfillClosure`): mock API returning `202 {queued:true}` → banner shows "Reconciliación encolada" (scenario: successful dispatch — banner shows enqueued)
- [x] B1.2 RED — Add test: `202 {queued:false, reason:'already-running'}` → "Ya hay una reconciliación en curso" (scenario: already running — banner shows in-progress)
- [x] B1.3 RED — Add test: `503 {reason:'unavailable'}` → "No disponible" (scenario: unavailable — banner shows error)
- [x] B1.4 GREEN — Modify `src/api/iclassClosure.api.ts`: `backfill()` returns `BackfillTriggerResult`-shaped union; delete `ClosureBackfillResult` interface.
- [x] B1.5 GREEN — Update `IClassClosureFlagBody.tsx`: `useRunClosureBackfill` / banner branch on `queued` / `reason`; remove all count rendering; make pending count a `<Link to="/admin/scheduling/iclass/closure/pending">`.
- [x] B1.6 REFACTOR — Run `npx vitest run IClassClosureFlagBody`; all 3 banner scenarios green.

### Phase B2: Pending Page (TDD)

- [x] B2.1 RED — Write test for `ClosurePendingPage`: renders `ClosureProgressTable` when user has `iclass.manage` (scenario: pending page renders the progress table)
- [x] B2.2 RED — Add test for `ClosurePendingPage`: `RequirePermission` blocks access without permission (scenario: pending page is permission-gated)
- [x] B2.3 GREEN — Create `src/pages/scheduling/ClosurePendingPage.tsx`: lazy component; wraps `ClosureProgressTable` inside `<RequirePermission permission="iclass.manage">`.
- [x] B2.4 GREEN — Modify `src/App.tsx`: add lazy import + route `scheduling/iclass/closure/pending` → `<ClosurePendingPage />`.
- [x] B2.5 REFACTOR — Run `npx vitest run ClosurePendingPage`; green.

### Phase B3: IClassSettingsBody Cleanup (TDD)

- [x] B3.1 RED — Update `IClassSettingsBody.test.tsx`: assert `ClosureProgressTable` is NOT rendered in the Procesamiento sub-tab (scenario: ClosureProgressTable removed from Procesamiento sub-tab)
- [x] B3.2 GREEN — Modify `IClassSettingsBody.tsx`: remove `<ClosureProgressTable />` import and usage from sub-tab.
- [x] B3.3 RED — Add test for pending count link: `IClassClosureFlagBody` renders count as `<Link>` to `/admin/scheduling/iclass/closure/pending` (scenario: pending count is a link)
- [x] B3.4 GREEN — Confirm B1.5 already satisfies B3.3; run `npx vitest run IClassSettingsBody` + `IClassClosureFlagBody`.

### Phase B4: Polish + Full Verify

- [x] B4.1 IMPECCABLE — Review `ClosurePendingPage.tsx` layout: heading, empty state, spacing consistent with other scheduling pages.
- [ ] B4.2 Run full BE suite: `npx jest --runInBand` — all green.
- [x] B4.3 Run full FE suite: `npx vitest run` — all green. (237 files, 1984 tests passed, 0 failures)
- [x] B4.4 `npx tsc --noEmit` (BE) + `npm run typecheck` (FE) — zero errors.
- [ ] B4.5 Manual smoke: trigger backfill → 202 banner; navigate to `/admin/scheduling/iclass/closure/pending` → table renders; Procesamiento sub-tab → no table.

---

## Scenario Coverage Map

| Spec Scenario | Task(s) |
|---|---|
| Backfill dispatched successfully | A3.1, A3.5 |
| Backfill while a run is already in flight | A3.2, A3.5 |
| Backfill when scheduler not available | A3.3, A3.5 |
| Unauthenticated backfill request | A3.4 |
| triggerNow returns before background work finishes | A1.1, A1.4 |
| triggerNow re-entrancy guard | A1.2, A1.4 |
| Advisory lock key is distinct | A1.3, A1.4 |
| Successful dispatch — banner shows enqueued | B1.1, B1.5 |
| Already running — banner shows in-progress | B1.2, B1.5 |
| Unavailable — banner shows error | B1.3, B1.5 |
| Pending page renders the progress table | B2.1, B2.3 |
| Pending page is permission-gated | B2.2, B2.3 |
| Pending count is a link | B3.3, B1.5 |
| ClosureProgressTable removed from Procesamiento sub-tab | B3.1, B3.2 |
