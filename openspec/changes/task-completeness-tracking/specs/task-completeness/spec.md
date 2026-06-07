# Spec delta — task-completeness-tracking (#14)

Capability: visibilidad y auto-completado del estado de cierre por tarea.

## ADDED Requirements

### Requirement: REQ-TC-1 — Flags de completitud en la tarea
`ScheduledTask` expone tres flags booleanos del cierre, consultables/medibles.

#### Scenario: el DTO de la tarea incluye los flags
- **WHEN** se devuelve una tarea por la API
- **THEN** trae `closureCommentDone`, `closureAuditDone`, `closureHasDeviceInventory` (default `false`).

### Requirement: REQ-TC-2 — El closure marca los flags going-forward
Al completar cada side-effect, el closure marca el flag correspondiente en la tarea.

#### Scenario: comentario posteado → flag
- **WHEN** `runClosureSideEffects` postea el comentario de cierre de una tarea
- **THEN** `closureCommentDone = true` para esa tarea.

#### Scenario: auditoría persistida → flag
- **WHEN** la auditoría IA persiste un `TaskInstallationAudit`
- **THEN** `closureAuditDone = true`.

#### Scenario: inventario con equipo → flag
- **WHEN** tras construir el inventario la tarea tiene ≥1 sugerencia/ítem DEVICE
- **THEN** `closureHasDeviceInventory = true`.

### Requirement: REQ-TC-3 — "Inventario hecho" cuenta solo equipos DEVICE
Los materiales NO cuentan para `closureHasDeviceInventory`.

#### Scenario: solo materiales → flag queda false
- **WHEN** la tarea solo tiene sugerencias/ítems MATERIAL (sin DEVICE)
- **THEN** `closureHasDeviceInventory = false`.

#### Scenario: ≥1 DEVICE no descartado → true
- **WHEN** hay al menos una sugerencia DEVICE con status ≠ `discarded`, o un `ContractInstalledItem` con `sourceTaskId` de la tarea
- **THEN** `closureHasDeviceInventory = true`.

### Requirement: REQ-TC-4 — Backfill idempotente de tareas existentes
Las tareas previas reciben sus flags desde las relaciones actuales.

#### Scenario: backfill desde el estado actual
- **WHEN** corre el backfill (migración)
- **THEN** marca `closureAuditDone` si existe `TaskInstallationAudit`; `closureHasDeviceInventory` si hay sugerencia DEVICE no descartada; `closureCommentDone` si su `IClassServiceOrder.commentPosted = true`. Re-correrlo no cambia el resultado.

### Requirement: REQ-TC-5 — Auto-completado por cron + flag
Un job periódico, gateado por `task-autocomplete` (default OFF), auto-completa las tareas incompletas reusando la maquinaria existente.

#### Scenario: flag OFF → dormido
- **WHEN** `task-autocomplete` está OFF
- **THEN** el job no hace nada.

#### Scenario: flag ON → re-dispara lo pendiente
- **WHEN** `task-autocomplete` está ON
- **THEN** el job corre `ReprocessClosureSideEffects` (reusado con `flagKey: 'task-autocomplete'`), que re-dispara comentario/auditoría/inventario faltantes; al completarse, los flags de la tarea se marcan vía `runClosureSideEffects`.

## Out of scope
- Alta manual de equipo (#19); dashboards/reportes; cambiar la lógica de cierre/OCR/auditoría.
