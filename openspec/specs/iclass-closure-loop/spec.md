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

## REQ-BACKFILL-1 — Reconcile on-demand
`POST /api/admin/iclass/closure/backfill` DEBE reconciliar las tareas en "Registrado en IClass" consultando por `serviceOrderCode` y reusando el mismo procesamiento. Idempotente.

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
