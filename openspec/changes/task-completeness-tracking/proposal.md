# Proposal — task-completeness-tracking (#14)

Mode: interactive · Store: hybrid (openspec + engram `sdd/task-completeness-tracking/*`).

## Why

Hoy el estado de los procesos del cierre (comentario, auditoría IA, inventario) vive **por OS cerrada** (`IClassServiceOrder`: `commentPosted`/`auditDone`/`inventoryBuilt`) y solo se opera **manual** (Reconciliar / Reprocesar). No hay forma de **medir a nivel datos** qué TAREAS están incompletas, ni un proceso que las auto-complete.

Se quieren **campos en la tarea** para ver/medir qué le falta, y un **cron** que auto-complete lo que se pueda.

## Decisiones (confirmadas con el usuario)

- **AD-1 — Campos en `ScheduledTask`** (no derivar): tres flags de completitud del cierre, para poder consultarlos/medirlos a escala con queries simples:
  - `closureCommentDone` — ¿se posteó el comentario de cierre en la tarea?
  - `closureAuditDone` — ¿se hizo la auditoría IA (existe `TaskInstallationAudit`)?
  - `closureHasDeviceInventory` — ¿la tarea registró **al menos un equipo DEVICE** (ONU/router/antena/…)? **Los materiales NO cuentan.**
- **AD-2 — "Inventario hecho" = hay DEVICE**: el flag de inventario es `true` solo si hay ≥1 sugerencia/ítem **DEVICE** asociado a la tarea (no si solo hay materiales, no si está vacío). Es la métrica de negocio "se cargó el equipo".
- **AD-3 — Auto-completado por cron + flag** (default OFF): un job periódico, gateado por un feature flag nuevo, que busca tareas incompletas y **reusa** `BackfillClosedServiceOrders` + `ReprocessClosureSideEffects` (ya existentes) para re-disparar lo que falta (comentario, auditoría, re-OCR del inventario). No reimplementa la lógica de cierre.
- **AD-4 — Llenado de los campos**: going-forward el closure marca los flags en la tarea al hacer cada side-effect; un **backfill** (one-shot) los completa para las tareas ya existentes desde las relaciones actuales (`TaskInstallationAudit`, `TaskInventorySuggestion`/`ContractInstalledItem`, `TaskComment`/`commentPosted`).

## What changes

### Backend
- Migración aditiva: 3 columnas en `ScheduledTask` (`closureCommentDone`, `closureAuditDone`, `closureHasDeviceInventory`, default `false`) + backfill de las existentes (en la misma migración o un job idempotente).
- El closure (`runClosureSideEffects`) marca los flags en la tarea cuando completa cada side-effect (comentario/auditoría), y recomputa `closureHasDeviceInventory` tras construir el inventario.
- Nuevo flag `task-autocomplete` + un scheduler/job (patrón `IClassClosureScheduler`: re-lee el flag por tick, dormido si OFF) que corre el auto-completado reusando backfill+reprocess.
- El DTO de la tarea expone los 3 flags (para la UI/medición).

### Frontend (mínimo)
- Toggle del flag `task-autocomplete` en la config de IClass (sub-page de cierre), patrón del toggle del auditor (#7).
- (Opcional, a confirmar) un badge/indicador de completitud en la tarea o un contador de incompletas.

## Impact / Out of scope
- **Out of scope**: el alta manual de equipo (#19, complementario); cambiar la lógica del cierre/auditoría/OCR; reportes/dashboards elaborados (esto deja los DATOS para medir, no construye el dashboard).
- **Riesgo**: medio. Las columnas **duplican** estado que ya vive en el mirror/relaciones → la sincronización (going-forward + backfill) debe ser sólida o se desincronizan. El cron arranca OFF (sin efecto hasta prenderlo).
- **Migración aditiva** (columnas con default) → segura; el backfill es idempotente.

## Puntos a confirmar (los dejé con un default; decime si cambia alguno)
1. `closureHasDeviceInventory`: ¿cuenta una **sugerencia** DEVICE (aunque no esté confirmada) o solo un **ítem instalado/confirmado**? Default propuesto: **cuenta si hay sugerencia DEVICE no descartada O ítem instalado** (es "se detectó/cargó el equipo").
2. ¿La auditoría cuenta por existir `TaskInstallationAudit` con hallazgos, o también el "ok sintético"? Default: **cualquier `TaskInstallationAudit` persistido** (incluido el "sin observaciones").
3. ¿El cron corre el reprocess **global** (todas las OS con pendientes) o acotado a un universo? Default: **reusa el reprocess global existente** (ya itera `listPendingSideEffects` con cap).
