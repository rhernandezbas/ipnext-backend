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
El scheduler DEBE re-leer el flag `iclass-closure-loop` cada tick (default OFF), usar advisory lock `iclass-closed`, y tragar errores sin matar el timer.

## REQ-BACKFILL-1 — Reconcile on-demand
`POST /api/admin/iclass/closure/backfill` DEBE reconciliar las tareas en "Registrado en IClass" consultando por `serviceOrderCode` y reusando el mismo procesamiento. Idempotente.

## REQ-STATUS-1 — Estado
`GET /api/admin/iclass/closure/status` DEBE devolver `lastRunAt` + counts `{ mirrored, transitioned, skippedNotClosed, skippedNotOurs, skippedUnchanged }`; null/ceros antes del primer run.
