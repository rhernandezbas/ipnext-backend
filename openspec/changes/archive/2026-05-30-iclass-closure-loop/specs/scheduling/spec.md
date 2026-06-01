# Spec: scheduling (DELTA)

Delta sobre la capability `scheduling` para el closure loop.

## ADDED — Back-relation al espejo de cierre
`ScheduledTask` gana la relación inversa `iclassClosedOrder` (one-to-one nullable) hacia `IClassServiceOrder` (FK `scheduledTaskId @unique`, onDelete SetNull). Columna virtual; sin cambios destructivos.

## ADDED — Lookups para el closure loop
`SchedulingRepository` gana:
- `findTaskBySequenceNumber(n)` — el join key del cierre (codigo↔sequenceNumber).
- `listTasksInIClassStage(stageName)` — tareas enviadas y a la espera de cierre, para el backfill.

## MODIFIED — Transición disparada por el cierre
Una `ScheduledTask` PUEDE ser movida de stage por el closure loop (no solo por acción manual del usuario), al estado configurado en `IClassResultCode.mappedStageId` para el resultado de cierre de su OS. La transición usa el `moveTaskToStage` existente.
