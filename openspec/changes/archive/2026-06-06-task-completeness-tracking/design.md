# Design — task-completeness-tracking (#14)

BE (grueso) + FE (toggle). Reusa al máximo la maquinaria del cierre.

## 1. Modelo + migración
- `ScheduledTask` += 3 columnas `Boolean @default(false)`: `closureCommentDone`, `closureAuditDone`, `closureHasDeviceInventory`.
- Entidad `domain/entities` ScheduledTask + el `toEntity` del `PrismaSchedulingRepository` + `CreateTaskInput`/Update omits (mismo recorrido que `reviewedByInventory`).
- Migración aditiva (`<ts>_task_completeness_fields`) con los `ADD COLUMN` + **backfill** en el mismo archivo (idempotente):
  ```sql
  UPDATE "ScheduledTask" t SET "closureAuditDone" = true
   WHERE EXISTS (SELECT 1 FROM "TaskInstallationAudit" a WHERE a."taskId" = t.id);
  UPDATE "ScheduledTask" t SET "closureHasDeviceInventory" = true
   WHERE EXISTS (SELECT 1 FROM "TaskInventorySuggestion" s
                 WHERE s."taskId" = t.id AND s."kind" = 'DEVICE' AND s."status" <> 'discarded');
  UPDATE "ScheduledTask" t SET "closureCommentDone" = true
   WHERE EXISTS (SELECT 1 FROM "IClassServiceOrder" o
                 WHERE o."scheduledTaskId" = t.id AND o."commentPosted" = true);
  ```

## 2. Marcado going-forward (closure)
- Nuevo método en el port: `SchedulingRepository.markClosureCompleteness(taskId, partial: { closureCommentDone?; closureAuditDone?; closureHasDeviceInventory? })`. **Dedicado** (no `updateTask`) para NO disparar eventos del activity-log diff.
- `runClosureSideEffects` (`IngestClosedServiceOrders`):
  - tras marcar `commentPosted` en la OS → `markClosureCompleteness(taskId, { closureCommentDone: true })`.
  - tras la auditoría (cuando `auditInstallation.execute` devuelve no-null) → `{ closureAuditDone: true }`.
  - tras `buildSuggestions` → recomputar DEVICE: si entre las `extractions`/sugerencias de la tarea hay ≥1 DEVICE → `{ closureHasDeviceInventory: true }`. (Helper en el repo de sugerencias: `hasDeviceForTask(taskId)` → existe DEVICE no descartado.)
- Como el reprocess y el cron pasan por `runClosureSideEffects`, los flags se marcan en los 3 caminos sin duplicar código.

## 3. Cron de auto-completado
- Flag nuevo `task-autocomplete` (seed por migración, default `false`).
- `ReprocessClosureSideEffects` ya acepta `opts.flagKey` → instanciar una variante con `flagKey: 'task-autocomplete'`. El cron NO reimplementa: corre esa instancia.
- Scheduler nuevo `TaskAutocompleteScheduler` (espeja `IClassClosureScheduler`: `inFlight` + `DistributedLock` distinto + intervalo fijo; re-lee el flag por tick; arranca dormido). Bootstrap en el wiring junto a los otros schedulers.

## 4. DTO + FE
- El DTO/respuesta de la tarea expone los 3 flags (junto a `reviewedByInventory`).
- FE: toggle de `task-autocomplete` en la sub-page "Cierre de OS" (patrón del toggle del auditor #7, gate `iclass.manage`). La visibilidad por tarea (badges) queda fuera de scope salvo que se pida — los DATOS ya quedan expuestos para medir.

## Tests (TDD)
- **BE**:
  - `IngestClosedServiceOrders.test`: tras el cierre, los 3 flags quedan marcados (comment/audit/inventory-DEVICE); con solo materiales → `closureHasDeviceInventory` false.
  - Helper `hasDeviceForTask` (repo in-memory): DEVICE no descartado → true; solo materiales → false; DEVICE descartado → false.
  - Cron/scheduler: con flag OFF no corre; con ON corre el reprocess (test del use-case reusado con flagKey).
- **FE**: toggle refleja/flip `task-autocomplete` (extender el mock de flags como en #7).

## Riesgos / decisiones
- **Duplicación de estado** (las columnas vs el mirror): mitigada porque TODO marcado va por `runClosureSideEffects` (un solo lugar) + backfill idempotente. Si en el futuro se quiere una sola fuente, las columnas se pueden recomputar con el backfill.
- Migración aditiva + backfill idempotente → push directo seguro; **revisar el SQL con el usuario** antes de pushear.
- El cron arranca OFF → sin efecto hasta prenderlo (rollout controlado, como closure-loop/audit).
