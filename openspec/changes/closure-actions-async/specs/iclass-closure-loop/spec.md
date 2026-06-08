# Delta for iclass-closure-loop

Change: closure-actions-async (#32)

## MODIFIED Requirements

### Requirement: REQ-BACKFILL-1 — Reconcile on-demand (async)

`POST /api/admin/iclass/closure/backfill` MUST return `202` immediately by dispatching the background run via `BackfillScheduler.triggerNow()`. It MUST NOT await IClass API calls, OCR, or audit operations.

The endpoint MUST be guarded by `auth` + `requireIClassManage`. It MUST NOT require a feature flag — backfill is admin-triggered only.

| Response condition | Status | Body |
|---|---|---|
| Dispatch succeeded | 202 | `{ queued: true }` |
| Run already in flight / advisory lock held | 202 | `{ queued: false, reason: 'already-running' }` |
| `BackfillScheduler` not wired (null) | 503 | `{ reason: 'unavailable' }` |

(Previously: 200, awaited full BackfillClosedServiceOrders.execute() synchronously — caused HTTP timeouts on ~78 sequential IClass calls + Ollama calls)

#### Scenario: Backfill dispatched successfully

- GIVEN the BackfillScheduler is wired and no run is in flight
- WHEN `POST /api/admin/iclass/closure/backfill` is called
- THEN the server responds `202 { queued: true }` before IClass/OCR/audit work completes
- AND `BackfillClosedServiceOrders.execute()` runs in the background

#### Scenario: Backfill while a run is already in flight

- GIVEN a background backfill run is currently executing (`inFlight` is true OR advisory lock is held)
- WHEN `POST /api/admin/iclass/closure/backfill` is called
- THEN the server responds `202 { queued: false, reason: 'already-running' }`
- AND no second parallel run is started

#### Scenario: Backfill when scheduler is not available

- GIVEN the BackfillScheduler was not wired in app.ts (null)
- WHEN `POST /api/admin/iclass/closure/backfill` is called
- THEN the server responds `503 { reason: 'unavailable' }`

#### Scenario: Unauthenticated backfill request

- GIVEN no valid auth token is provided
- WHEN `POST /api/admin/iclass/closure/backfill` is called
- THEN the server responds `401`

## ADDED Requirements

### Requirement: REQ-BACKFILL-SCHEDULER-1 — BackfillScheduler non-blocking guard

`BackfillScheduler` MUST expose `triggerNow(): TriggerResult` that initiates `BackfillClosedServiceOrders.execute()` as a fire-and-forget operation (does NOT `await`) and returns immediately.

`BackfillScheduler` MUST maintain an `inFlight` boolean guard — if true when `triggerNow()` is called, it MUST return `{ queued: false, reason: 'already-running' }` without starting a second run.

`BackfillScheduler` MUST acquire `PgAdvisoryLock` with key `'iclass-closure-backfill'` before executing — this key MUST NOT collide with the reprocess lock (`'task-autocomplete'`) or the cron lock (`'iclass-closed'`).

`BackfillScheduler` MUST have NO cron timer — it is manual-trigger-only.

#### Scenario: triggerNow returns before background work finishes

- GIVEN the scheduler is idle (`inFlight` is false)
- WHEN `triggerNow()` is called
- THEN it returns `{ queued: true }` synchronously before `execute()` completes
- AND `execute()` runs in the background

#### Scenario: triggerNow re-entrancy guard

- GIVEN `inFlight` is true (a run is executing)
- WHEN `triggerNow()` is called
- THEN it returns `{ queued: false, reason: 'already-running' }` immediately
- AND no second parallel run starts

#### Scenario: Advisory lock key is distinct

- GIVEN the BackfillScheduler uses `PgAdvisoryLock('iclass-closure-backfill')`
- WHEN a concurrent reprocess or cron run holds its own lock
- THEN the backfill lock acquisition is independent and does not block or get blocked by those locks

### Requirement: REQ-BACKFILL-ASYNC-FE-1 — Backfill banner reflects async response

The FE backfill trigger MUST handle the `TriggerResult` union from `202` and display:

| Server response | Banner text |
|---|---|
| `202 { queued: true }` | "Reconciliación encolada" |
| `202 { queued: false, reason: 'already-running' }` | "Ya hay una reconciliación en curso" |
| `503 { reason: 'unavailable' }` | "No disponible" |

The banner MUST NOT display counts (the async response carries no result data).

#### Scenario: Successful dispatch — banner shows enqueued

- GIVEN the server responds `202 { queued: true }`
- WHEN the user triggers backfill
- THEN the banner shows "Reconciliación encolada"

#### Scenario: Already running — banner shows in-progress

- GIVEN the server responds `202 { queued: false, reason: 'already-running' }`
- WHEN the user triggers backfill
- THEN the banner shows "Ya hay una reconciliación en curso"

#### Scenario: Unavailable — banner shows error

- GIVEN the server responds `503 { reason: 'unavailable' }`
- WHEN the user triggers backfill
- THEN the banner shows "No disponible"

### Requirement: REQ-BACKFILL-PENDING-PAGE-1 — Standalone closure pending page

The system MUST provide a standalone `ClosurePendingPage` at `/admin/scheduling/iclass/closure/pending`, gated by the `iclass.manage` permission via `RequirePermission`.

`ClosureProgressTable` MUST be rendered ONLY on `ClosurePendingPage` — it MUST be removed from the Procesamiento sub-tab in `IClassSettingsBody`.

The pending count display in `IClassClosureFlagBody` MUST become a `<Link>` to `/admin/scheduling/iclass/closure/pending` instead of plain text.

#### Scenario: Pending page renders the progress table

- GIVEN the user has the `iclass.manage` permission
- WHEN they navigate to `/admin/scheduling/iclass/closure/pending`
- THEN `ClosurePendingPage` renders with `ClosureProgressTable`

#### Scenario: Pending page is permission-gated

- GIVEN the user does NOT have `iclass.manage`
- WHEN they navigate to `/admin/scheduling/iclass/closure/pending`
- THEN access is denied (redirected or blocked by `RequirePermission`)

#### Scenario: Pending count is a link

- GIVEN the `IClassClosureFlagBody` renders the pending count
- WHEN the pending count is displayed
- THEN it renders as a `<Link>` pointing to `/admin/scheduling/iclass/closure/pending`

#### Scenario: ClosureProgressTable removed from Procesamiento sub-tab

- GIVEN the user navigates to the Procesamiento sub-tab in IClass scheduling settings
- WHEN the sub-tab renders
- THEN `ClosureProgressTable` is NOT present in the sub-tab
