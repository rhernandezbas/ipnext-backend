# Design: Closure Actions Async (#32)

## Technical Approach

Make `POST /closure/backfill` fire-and-forget by introducing a thin **`BackfillScheduler`** that mirrors `TaskAutocompleteScheduler`'s guarded-trigger half (`inFlight` + `PgAdvisoryLock` + `triggerNow()`), but **without the cron**. The route returns the same `202`/`503` union as reprocess. FE splits `ClosureProgressTable` into a standalone permission-gated page and turns the pending count into a `<Link>` to it. No schema change.

## Architecture Decisions

| # | Decision | Choice | Rejected | Rationale |
|---|----------|--------|----------|-----------|
| 1 | Scheduler shape | New `BackfillScheduler` class: `triggerNow(): Promise<TriggerResult>` (`{queued:true}` \| `{queued:false, reason:'already-running'}`), `inFlight` guard, `PgAdvisoryLock('iclass-closure-backfill')`, `void runOnce()` calling `BackfillClosedServiceOrders.execute()` | Extend `TaskAutocompleteScheduler` (couples 2 ops); inline module flag (no cross-instance lock) | SRP, distinct deps, distinct lock key. Battle-tested half of the existing pattern. |
| 2 | `start()`? | **No `start()`, no `setInterval`, no `stop()`.** Purely on-demand. | Mirror autocomplete with a dormant tick | Backfill has no recurring schedule — it's manual-only. A cron would re-trigger 78+ IClass calls unprompted. No timer means nothing to start. |
| 3 | `TriggerResult` reason set | Only `'already-running'` (no `'flag-disabled'`) | Reuse autocomplete's 3-variant union | Backfill is admin-only, ungated by feature flag. Reuse the exported `TriggerResult` *type* is impossible (it carries `flag-disabled`); define a backfill-local `BackfillTriggerResult = {queued:true} \| {queued:false; reason:'already-running'}`. |
| 4 | Bootstrap | New `bootstrapBackfill.ts` (composition root, mirrors `bootstrapTaskAutocomplete.ts`); returns `BackfillScheduler \| null` (null when IClass creds missing). | Inline in `main.ts` | Consistency with every other scheduler; testable in isolation; keeps `main.ts` thin. |
| 5 | Router signature | `createIClassClosureRouter` **replaces** the `backfillClosedOrders: BackfillClosedServiceOrders` param with `backfillScheduler: BackfillScheduler \| null` (same positional slot, #5). Router no longer holds the raw use case — the scheduler owns it. | Keep both params | Single source of truth; the use case now lives inside the scheduler. Route does `if (!scheduler) 503; else 202 triggerNow()` — identical shape to reprocess. |
| 6 | FE backfill banner | `useRunClosureBackfill` returns the 202 union; banner shows "Reconciliación encolada" / "Ya hay una reconciliación en curso" / "No disponible". Drop all count rendering. | Keep count banner | 202 carries no counts. Pending-list polling already shows the queue draining. |
| 7 | FE pending page | New lazy `ClosurePendingPage.tsx` wrapping `ClosureProgressTable`; route `scheduling/iclass/closure/pending` gated `<RequirePermission permission="iclass.manage">`; count → `<Link>`; remove `<ClosureProgressTable/>` from `IClassSettingsBody`. | Leave table in sub-tab | Decouples the heavy polling table from the settings sub-tab; matches the async mental model (trigger here, watch there). |

## Data Flow

```
POST /closure/backfill
   │
   ▼
route handler ── scheduler null? ──► 503 {reason:'unavailable'}
   │ else
   ▼
backfillScheduler.triggerNow() ──► returns 202 immediately
   │  (inFlight? → {queued:false, reason:'already-running'})
   └─ void runOnce()  (fire-and-forget)
          │ tryAcquire('iclass-closure-backfill')
          ▼
       BackfillClosedServiceOrders.execute()
          └─ 78+ IClass calls + processSummary + side-effects (OCR/audit)
          ▼ finally: inFlight=false; lock.release()

FE: count <Link> ─► /admin/scheduling/iclass/closure/pending ─► ClosureProgressTable (polls pending-list)
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/infrastructure/scheduling/BackfillScheduler.ts` | Create | `inFlight` + `PgAdvisoryLock('iclass-closure-backfill')` + `triggerNow()`/`runOnce()`. No timer. |
| `src/infrastructure/scheduling/bootstrapBackfill.ts` | Create | Build `BackfillClosedServiceOrders` + `BackfillScheduler`; returns `null` on missing IClass creds. |
| `src/infrastructure/http/routes/iclass-closure.routes.ts` | Modify | backfill: `200 await execute()` → `202 triggerNow()` / `503`. Swap param `backfillClosedOrders` → `backfillScheduler`. |
| `src/infrastructure/http/app.ts` (~1255) | Modify | `createApp` gains a `backfillScheduler` param; pass it into `createIClassClosureRouter` (drop the inline `new BackfillClosedServiceOrders(...)`). |
| `src/main.ts` | Modify | async IIFE: `await bootstrapBackfill(...)` before `createApp`; pass into `createApp`. No `.start()` call. |
| `src/__tests__/infrastructure/iclass-closure.routes.test.ts` | Modify | backfill expects 202 / 503 with stub scheduler. |
| `src/__tests__/infrastructure/BackfillScheduler.test.ts` | Create | unit: 202 dispatch, already-running, lock not acquired → skip. |
| FE `src/pages/scheduling/ClosurePendingPage.tsx` | Create | lazy page wrapping `ClosureProgressTable`. |
| FE `src/App.tsx` | Modify | add gated route under `scheduling`; lazy import. |
| FE `src/api/iclassClosure.api.ts` | Modify | `backfill` returns `ClosureReprocessQueued`-shaped union (no `ClosureBackfillResult`). |
| FE `src/pages/.../IClassClosureFlagBody.tsx` | Modify | banner → queued/already-running/unavailable; count → `<Link>`. |
| FE `src/pages/.../IClassSettingsBody.tsx` | Modify | remove `<ClosureProgressTable/>` from sub-tab. |

## Interfaces / Contracts

```ts
// BackfillScheduler.ts
const LOCK_KEY = 'iclass-closure-backfill';
export type BackfillTriggerResult =
  | { queued: true }
  | { queued: false; reason: 'already-running' };

export class BackfillScheduler {
  private inFlight = false;
  constructor(private readonly backfill: BackfillClosedServiceOrders,
              private readonly lock: DistributedLock,
              private readonly opts: { silent?: boolean } = {}) {}
  async triggerNow(): Promise<BackfillTriggerResult> {
    if (this.inFlight) return { queued: false, reason: 'already-running' };
    void this.runOnce();
    return { queued: true };
  }
  async runOnce(): Promise<{ skipped?: boolean; error?: string }> { /* lock → inFlight → execute → finally release */ }
}
```

Route (mirrors reprocess): `if (!backfillScheduler) 503 {reason:'unavailable'}; else 202 await backfillScheduler.triggerNow()`.

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Unit | `BackfillScheduler`: queued, already-running (re-entrant `inFlight`), lock-held → skip | Fake `BackfillClosedServiceOrders` + in-memory `DistributedLock`; assert `execute` called once, lock acquired/released. |
| Integration | backfill route 202 / 503 | supertest + stub scheduler (null and present); assert no awaiting of counts. |
| FE unit | banner queued/already-running; count is `<Link>`; table absent from sub-tab; page renders table | RTL on `IClassClosureFlagBody`, `IClassSettingsBody`, new `ClosurePendingPage`. |

## Migration / Rollout

No migration required. No schema, no new env var. New advisory-lock key `'iclass-closure-backfill'` is namespaced and collision-free. Rollback = revert route to `200 await execute()` and restore the table in the sub-tab.

## Open Questions

- None blocking. (Note: `ClosureBackfillResult` interface becomes unused on FE — delete it with the banner change.)
