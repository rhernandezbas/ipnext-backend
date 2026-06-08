# Spec: iclass-closure-loop (NEW)

Ingesta de OS cerradas de IClass + mapping configurable result-code→Stage + transición de la tarea local.

## REQ-SRC-1 — Pull de OS cerradas
El sistema DEBE listar OS vía `GET /serviceorders` (clusterName requerido, ventana `updatedDate` ≤30 días, formato `dd-MM-yyyy HH:mm`) y normalizar la respuesta JSON a un summary plano.
- **Given** el scheduler corre con el flag ON, **When** consulta IClass, **Then** pagina mientras `hasMoreElements` y trata 204 como vacío.

## REQ-FILTER-1 — Solo cerradas
El sistema DEBE procesar únicamente OS con `status.id === '7'` (Concluida); las demás se cuentan como `skippedNotClosed`.

## REQ-JOIN-1 — Match a tarea local
El sistema DEBE matchear la OS con una `ScheduledTask` por `SO.codigo === sequenceNumber`.
- **Given** una OS con codigo numérico que matchea una tarea, **Then** la procesa.
- **Given** una OS con `codigo == id` (creada en IClass, sin tarea), **Then** la skipea como `skippedNotOurs`.

## REQ-IDEMP-1 — Idempotencia
- **Given** una OS ya espejada con el mismo `iclassUpdatedAt` (alteradoPor.data), **When** se reprocesa, **Then** se skipea (`skippedUnchanged`) sin traer sub-recursos.

## REQ-MIRROR-1 — Espejo del agregado
El sistema DEBE traer history, checklist, materiales y equipos (con backoff) y persistir el agregado, derivando `closedAt`/`firstClosedAt`/`approvedAt` del history. Las respuestas de tipo Foto se marcan `photoMissing` (la API v2 no expone imágenes).

## REQ-MAP-1 — Mapping configurable result-code → Stage
El catálogo `IClassResultCode` DEBE permitir asignar (o limpiar con null) un `mappedStageId` por result-code, vía `PATCH /api/admin/iclass/result-codes/:id { stageId }`.
- **Given** stageId inexistente, **Then** 404 `STAGE_NOT_FOUND`.
- **Given** result-code inexistente, **Then** 404 `ICLASS_RESULT_CODE_NOT_FOUND`.
- El sync (`POST /result-codes/sync`) DEBE preservar el mapping configurado.

## REQ-MOVE-1 — Transición de la tarea
- **Given** una OS cerrada matcheada cuyo `motivoFechamento` resuelve a un result-code con `mappedStageId`, **Then** la tarea se mueve a ese Stage (`transitioned`).
- **Given** el result-code sin mapeo, **Then** la OS se espeja pero la tarea NO se mueve.

## REQ-SYNC-CAT-1 — Sync del catálogo
El sync DEBE descubrir los soType ids desde `tipoOs.id` de OS recientes (los endpoints de tipos no exponen id numérico) y traer `/serviceordertypes/{id}/resultcodes`, deduplicando por `(soTypeId, code)`.

## REQ-SCHED-1 — Scheduler gateado
El cron scheduler DEBE re-leer el flag `task-autocomplete` cada tick (default OFF), usar advisory lock `iclass-closed`, y tragar errores sin matar el timer. El cron tick DEBE usar `flagKey = 'task-autocomplete'`.

El manual HTTP trigger y el cron tick DEBEN compartir el mismo guard `inFlight` y advisory lock así se serializan — solo un run ejecuta a la vez sin importar el origen.

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

## REQ-BACKFILL-1 — Reconcile on-demand (async)

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

## REQ-STATUS-1 — Estado
`GET /api/admin/iclass/closure/status` DEBE devolver `lastRunAt` + counts `{ mirrored, transitioned, skippedNotClosed, skippedNotOurs, skippedUnchanged }`; null/ceros antes del primer run.

## REQ-REPROCESS-1 — Async reprocess dispatch

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

## REQ-PENDING-COUNT-1 — Pending-count progress endpoint

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

## REQ-CLOSURE-SIDE-EFFECTS-WITH-TASK-1 — listPendingSideEffectsWithTask port method

`ClosedServiceOrderRepository` MUST expose `listPendingSideEffectsWithTask(maxAuditAttempts: number)` returning an array of items typed as `PendingClosureSideEffectsWithTask`. Each item MUST include all fields from `PendingClosureSideEffects` (`iclassId`, `scheduledTaskId`, `commentPosted`, `inventoryBuilt`, `auditDone`, `auditAttempts`) plus an optional `task` field (`{ id: string; sequenceNumber: number; title: string } | null`). The method MUST resolve the task in a single query (no N+1) using a JOIN or include. The in-memory adapter MUST implement the same method.

#### Scenario: Port returns items with joined task

- GIVEN the in-memory adapter has 2 pending SOs, one with `scheduledTaskId` pointing to a seeded task
- WHEN `listPendingSideEffectsWithTask(maxAuditAttempts)` is called
- THEN it returns 2 items: one with `task.sequenceNumber` populated, one with `task: null`

#### Scenario: Port returns empty array when nothing pending

- GIVEN the in-memory adapter has no pending SOs
- WHEN `listPendingSideEffectsWithTask(maxAuditAttempts)` is called
- THEN it returns `[]`

#### Scenario: Port method is additive — existing listPendingSideEffects unchanged

- GIVEN both `listPendingSideEffects` and `listPendingSideEffectsWithTask` are defined on the port
- WHEN `listPendingSideEffects` is called (by existing use cases)
- THEN its behavior and return shape are unchanged

## REQ-TRIGGER-1 — Non-blocking triggerNow on scheduler

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

## REQ-BACKFILL-SCHEDULER-1 — BackfillScheduler non-blocking guard

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

## REQ-BACKFILL-ASYNC-FE-1 — Backfill banner reflects async response

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

## REQ-BACKFILL-PENDING-PAGE-1 — Standalone closure pending page

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
