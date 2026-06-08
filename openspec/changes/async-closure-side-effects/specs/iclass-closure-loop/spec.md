# Delta for iclass-closure-loop

Change: async-closure-side-effects (#23)

## ADDED Requirements

### Requirement: REQ-REPROCESS-1 — Async reprocess dispatch

`POST /api/admin/iclass/closure/reprocess` MUST return `202` immediately by dispatching the background run via `TaskAutocompleteScheduler.triggerNow()`. It MUST NOT await OCR, audit, or comment operations.

The endpoint MUST be guarded by `auth` + `requireIClassManage`. The manual run MUST use flag key `iclass-closure-reprocess`; it MUST be independent of the `task-autocomplete` cron flag.

| Response condition | Status | Body |
|---|---|---|
| Dispatch succeeded | 202 | `{ queued: true }` |
| Run already in flight / lock held | 202 | `{ queued: false, reason: 'already-running' }` |
| `iclass-closure-reprocess` flag OFF | 202 | `{ queued: false, reason: 'flag-disabled' }` |

#### Scenario: Reprocess dispatched successfully

- GIVEN the `iclass-closure-reprocess` flag is ON and no run is in flight
- WHEN `POST /api/admin/iclass/closure/reprocess` is called
- THEN the server responds `202 { queued: true }` in under 1 s
- AND the OCR/audit/comment work runs in the background without blocking the HTTP response

#### Scenario: Reprocess while a run is already in flight

- GIVEN a background reprocess run is currently executing (`inFlight` is true OR advisory lock is held)
- WHEN `POST /api/admin/iclass/closure/reprocess` is called
- THEN the server responds `202 { queued: false, reason: 'already-running' }`
- AND no second parallel run is started

#### Scenario: Reprocess with manual flag OFF

- GIVEN the `iclass-closure-reprocess` flag is OFF
- WHEN `POST /api/admin/iclass/closure/reprocess` is called
- THEN the server responds `202 { queued: false, reason: 'flag-disabled' }`

#### Scenario: Manual reprocess with cron flag OFF

- GIVEN the `iclass-closure-reprocess` flag is ON and the `task-autocomplete` (cron) flag is OFF
- WHEN `POST /api/admin/iclass/closure/reprocess` is called
- THEN the server responds `202 { queued: true }` and the run proceeds normally
- AND cron flag state does NOT affect the manual trigger

#### Scenario: Unauthenticated reprocess request

- GIVEN no valid auth token is provided
- WHEN `POST /api/admin/iclass/closure/reprocess` is called
- THEN the server responds `401`

### Requirement: REQ-PENDING-COUNT-1 — Pending-count progress endpoint

`GET /api/admin/iclass/closure/reprocess/pending-count` MUST return the count of service orders with at least one pending side-effect (comment, inventory, or audit). It MUST delegate to `listPendingSideEffects` and return `{ pendingCount: number }`. It MUST be guarded by `auth` + `requireIClassManage`.

#### Scenario: Happy path — pending SOs exist

- GIVEN there are 5 service orders with pending side-effects
- WHEN `GET /api/admin/iclass/closure/reprocess/pending-count` is called
- THEN the server responds `200 { pendingCount: 5 }`

#### Scenario: No pending SOs

- GIVEN all side-effects are complete
- WHEN `GET /api/admin/iclass/closure/reprocess/pending-count` is called
- THEN the server responds `200 { pendingCount: 0 }`

#### Scenario: Unauthenticated pending-count request

- GIVEN no valid auth token is provided
- WHEN `GET /api/admin/iclass/closure/reprocess/pending-count` is called
- THEN the server responds `401`

### Requirement: REQ-TRIGGER-1 — Non-blocking triggerNow on scheduler

`TaskAutocompleteScheduler` MUST expose a `triggerNow(): void` method that initiates `runOnce()` as a fire-and-forget operation (does NOT `await`). `triggerNow()` MUST return before the background work completes.

`triggerNow()` MUST pass `flagKey = 'iclass-closure-reprocess'` to `runOnce()` so the manual run uses the manual flag, not the cron flag.

If `inFlight` is true when `triggerNow()` is called, it MUST resolve to `{ skipped: true }` via the existing guard — no parallel run is started.

#### Scenario: triggerNow returns before background work finishes

- GIVEN the scheduler is idle
- WHEN `triggerNow()` is called
- THEN it returns synchronously (void) before `runOnce()` completes
- AND `runOnce()` executes in the background

#### Scenario: triggerNow while in flight

- GIVEN `inFlight` is true
- WHEN `triggerNow()` is called
- THEN no second `runOnce()` starts; the in-flight run continues unaffected

## MODIFIED Requirements

### Requirement: REQ-SCHED-1 — Scheduler gateado

The cron scheduler MUST re-read the flag `task-autocomplete` every tick (default OFF), use advisory lock `iclass-closed`, and swallow errors without killing the timer. The cron tick MUST use `flagKey = 'task-autocomplete'`.

The manual HTTP trigger and the cron tick MUST share the same `inFlight` guard and advisory lock so they serialize — only one run executes at a time regardless of origin.

(Previously: single flag key `iclass-closure-loop` for both cron and manual, no separation of manual vs cron flag key)

#### Scenario: Cron tick runs when flag ON

- GIVEN the `task-autocomplete` flag is ON and no run is in flight
- WHEN the 15-min interval fires
- THEN `runOnce()` executes with `flagKey = 'task-autocomplete'`

#### Scenario: Cron tick skipped when already running

- GIVEN a run (manual or cron) is in flight
- WHEN the 15-min interval fires
- THEN the tick is skipped; the in-flight run continues

#### Scenario: Cron tick with flag OFF

- GIVEN the `task-autocomplete` flag is OFF
- WHEN the 15-min interval fires
- THEN `runOnce()` returns `{ skipped: true }` immediately
