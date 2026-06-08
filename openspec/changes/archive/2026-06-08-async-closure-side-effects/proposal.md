# Proposal: Async Closure Side-Effects Reprocess (#23)

## Intent

`POST /api/admin/iclass/closure/reprocess` runs OCR + audit synchronously (~19 min/SO, hours for 100+ SOs after the #20 reset). It blows past the LB timeout: the operator sees "No se pudo reprocesar" while the backend keeps working. The endpoint must enqueue and return immediately; the job runs in background with no HTTP timeout.

## Scope

### In Scope
- Add `triggerNow(): void` to `TaskAutocompleteScheduler` — fire-and-forget `void this.runOnce(...)`, returns immediately.
- Wire the scheduler reference into the closure router; reprocess endpoint dispatches and returns `202`.
- Decouple manual flag from cron flag (see Approach).
- New `GET /api/admin/iclass/closure/reprocess/pending-count` (thin over `listPendingSideEffects`) for FE progress.
- FE: handle `202`, show "encolado/en curso", disable button while running, poll pending-count.

### Out of Scope
- OCR per-photo attempt cap / perpetual-retry tracking (separate ticket).
- BullMQ / external job queue. In-process dispatch only.
- `maxPhotos` / VRAM / timeout tuning.
- Multi-replica beyond the existing `PgAdvisoryLock`.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `iclass-closure-loop`: reprocess endpoint becomes async (`200` sync result → `202` enqueue); manual trigger gated by its own flag, not the cron flag; new pending-count progress endpoint.

## Approach

Adopt **Option C** from exploration. `TaskAutocompleteScheduler` is already the background runner for the same `ReprocessClosureSideEffects` use case, with `inFlight` + `PgAdvisoryLock` guards already preventing double-processing. A crashed job is recovered by the next 15-min cron tick. A/B rejected: A is the same wiring without a clean named API; B reimplements the scheduler.

**Flag semantics**: the use case keeps its own flag check, gated by the `flagKey` passed in. `triggerNow()` runs with `flagKey='iclass-closure-reprocess'` (manual flag); the cron tick keeps `flagKey='task-autocomplete'`. Manual "Reprocesar" therefore works whenever `iclass-closure-reprocess` is ON, regardless of the cron flag. The shared `inFlight`/lock still serialize manual + cron runs.

**Response contract**: `202 { queued: true }` on dispatch. If `inFlight`/lock already held → `202 { queued: false, reason: 'already-running' }` (NOT `409` — nothing is wrong; the operator's intent is already satisfied). Flag OFF → `202 { queued: false, reason: 'flag-disabled' }`. FE renders "Reprocesamiento en curso".

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `infrastructure/scheduling/TaskAutocompleteScheduler.ts` | Modified | `triggerNow()` + manual flagKey run |
| `infrastructure/http/routes/iclass-closure.routes.ts` | Modified | `202` dispatch + pending-count GET |
| `infrastructure/http/app.ts` | Modified | Pass scheduler ref to closure router |
| `__tests__/.../iclass-closure.routes.test.ts`, `TaskAutocompleteScheduler.test.ts` | Modified | 202 + triggered-run + pending-count |
| FE `iclassClosure.api.ts`, `useIClassClosure.ts`, `IClassClosureFlagBody.tsx` | Modified | 202 state, poll pending-count |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| In-flight job lost on deploy/crash | Med | Side-effect flags skip done work; next cron tick retries |
| Double-trigger race before `inFlight` set | Low | `PgAdvisoryLock` serializes per replica; per-SO idempotency |
| #20 mass reset → multi-hour run | Med | `inFlight` serializes; `auditAttempts` cap; no HTTP timeout |

## Rollback Plan

Revert BE route to `200` sync + drop `triggerNow()`/pending-count; revert FE to await `200`. No schema/migration changes — pure code revert, no data cleanup.

## Dependencies

- Scheduler bootstrap must expose its instance to the route factory (`app.ts` wiring).

## Success Criteria

- [ ] Reprocess returns `202` in <1s regardless of pending count.
- [ ] Background job completes with no HTTP timeout.
- [ ] Manual reprocess works with `task-autocomplete` (cron) OFF.
- [ ] FE shows "encolado/en curso" and decrementing pending-count.
- [ ] Concurrent triggers never double-process (guard + lock).
