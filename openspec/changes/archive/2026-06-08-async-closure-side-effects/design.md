# Design: Async Closure Side-Effects Reprocess (#23)

## Technical Approach

Option C from exploration. `POST /closure/reprocess` stops awaiting the use case and instead asks the existing `TaskAutocompleteScheduler` to dispatch a fire-and-forget run, returning `202` in <1s. The scheduler already owns `inFlight` + `PgAdvisoryLock` and already runs the same `ReprocessClosureSideEffects` use case. We add a `triggerNow()` method, parameterize `runOnce()` by which use-case instance (flagKey) to run, thread the scheduler instance into the closure router, and add a thin pending-count endpoint for FE progress. No new infrastructure, no queue, no schema change.

## Architecture Decisions

### Decision: triggerNow() shape — sync decision, async work

| Option | Tradeoff | Decision |
|--------|----------|----------|
| triggerNow returns void, route returns 202 blindly | Can't surface already-running/flag-disabled | ✗ |
| triggerNow awaits the full run | Reintroduces the timeout — defeats the change | ✗ |
| **triggerNow does fast pre-checks, then `void runOnce()`** | Flag read is async but ~1ms | ✓ |

`triggerNow()` is `async` but only awaits a cheap flag read, never the OCR/audit work:
```ts
type TriggerResult = { queued: true } | { queued: false; reason: 'already-running' | 'flag-disabled' };

async triggerNow(): Promise<TriggerResult> {
  if (this.inFlight) return { queued: false, reason: 'already-running' };
  const flag = await this.flags.get(REPROCESS_FLAG_KEY);   // fast DB read
  if (!flag?.enabled) return { queued: false, reason: 'flag-disabled' };
  void this.runOnce(this.manualReprocess);                 // fire-and-forget
  return { queued: true };
}
```
`runOnce()` stays authoritative (re-checks `inFlight`, acquires the lock, re-checks the flag inside `execute()`). The pre-checks only shape the synchronous response; if a race makes the dispatched run a no-op, `queued:true` still holds ("a run is in progress"). Not `409` on already-running — the operator's intent is already satisfied.

### Decision: decouple manual flag from cron flag via parameterized runOnce

`runOnce(reprocess = this.reprocess)` defaults to the cron instance (`flagKey='task-autocomplete'`). The cron tick keeps calling `runOnce()` unchanged. Manual trigger calls `runOnce(this.manualReprocess)` where `manualReprocess` is a second `ReprocessClosureSideEffects` bound to `iclass-closure-reprocess`. Both share `inFlight` + the `task-autocomplete` advisory lock, so manual and cron runs serialize. Manual reprocess therefore works with the cron flag OFF. Alternative (one flag for both) rejected — couples two independent operator switches.

### Decision: pending-count via a thin use case, not repo-in-route

New `GetPendingSideEffectsCount` use case wraps `closed.listPendingSideEffects(3).length`, keeping the route free of repo access (hexagonal). Built in `app.ts` from the existing `closedServiceOrderRepo` — not threaded through the scheduler.

### Decision: wiring — bootstrap before createApp

`createApp(taskAutocomplete?)` gains an optional scheduler param. main.ts moves `bootstrapTaskAutocomplete()` above `createApp(...)`, passes the instance in, then calls `.start()` as before. When IClass creds are missing the bootstrap returns `null`; the route then answers `503 { queued:false, reason:'unavailable' }`. No new application→infrastructure import: the scheduler is infrastructure and is injected via the composition root.

## Data Flow

    POST /closure/reprocess ──→ scheduler.triggerNow()
         │                          │ inFlight? flag? (sync-ish)
         │ 202 {queued}  ◀──────────┘
         └ void runOnce(manualReprocess) ──→ execute() ──→ OCR/audit/comment (background, no HTTP)

    GET /closure/reprocess/pending-count ──→ GetPendingSideEffectsCount ──→ listPendingSideEffects().length ──→ 200 {pending}
    FE polls pending-count every 5s, stops at 0.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `infrastructure/scheduling/TaskAutocompleteScheduler.ts` | Modify | Add `triggerNow()`, `manualReprocess` + `flags` ctor deps, parameterize `runOnce(reprocess?)` |
| `infrastructure/scheduling/bootstrapTaskAutocomplete.ts` | Modify | Build `manualReprocess` (flagKey `iclass-closure-reprocess`), pass it + `flags` to scheduler |
| `application/use-cases/GetPendingSideEffectsCount.ts` | Create | Thin count over `listPendingSideEffects(3)` |
| `infrastructure/http/routes/iclass-closure.routes.ts` | Modify | Replace `reprocessClosure` param with scheduler + `getPendingCount`; `202` dispatch + `GET pending-count` |
| `infrastructure/http/app.ts` | Modify | `createApp(taskAutocomplete?)`; pass scheduler + count use case into router |
| `main.ts` | Modify | Bootstrap scheduler before `createApp`, inject it |
| FE `api/iclassClosure.api.ts` | Modify | `reprocess()` → queued union; add `pendingCount()` |
| FE `hooks/useIClassClosure.ts` | Modify | `useReprocessClosure` handles queued; add `usePendingCount` (refetchInterval) |
| FE `pages/scheduling/settings/IClassClosureFlagBody.tsx` | Modify | Banner "encolado"/"en curso"; show pending; disable while pending>0 |

## Interfaces / Contracts

```ts
// BE
TriggerResult = { queued: true } | { queued: false; reason: 'already-running' | 'flag-disabled' };
POST /api/admin/iclass/closure/reprocess               → 202 TriggerResult            (auth + requireIClassManage)
GET  /api/admin/iclass/closure/reprocess/pending-count → 200 { pending: number }      (auth + requireIClassManage)

// FE
interface ClosureReprocessQueued { queued: boolean; reason?: 'already-running' | 'flag-disabled' | 'unavailable'; }
interface ClosurePendingCount { pending: number; }
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | `triggerNow`: queued / already-running (inFlight) / flag-disabled; `runOnce(manualReprocess)` uses manual flag; cron path unchanged | InMemory flags + spy on `runOnce` |
| Unit | `GetPendingSideEffectsCount` returns `.length` | InMemory `ClosedServiceOrderRepository` |
| Integration | `POST reprocess` → 202 + body variants; `GET pending-count` → 200; auth 401 / perm 403 | supertest, scheduler stub injected |
| FE | queued banner, polling stops at 0, button disabled while pending | hook/component test |

## Migration / Rollout

No migration. Pure code; revert restores `200` sync. FE and BE ship together (response shape changes 200→202).

## Open Questions

- [ ] Pending-count response key: `{ pending }` (chosen) vs `{ count }` — confirm with FE naming.
