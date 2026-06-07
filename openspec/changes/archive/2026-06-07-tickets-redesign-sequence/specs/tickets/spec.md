# Spec delta — tickets-redesign-sequence (#11)

Capability: lista de tickets (ID secuencial + rediseño espejando tareas). Solo la LISTA (no el detalle).

## ADDED Requirements

### Requirement: REQ-TKT-1 — Ticket tiene un número secuencial
`Ticket` expone un `sequenceNumber` monotónico (no se reusa al borrar), como `ScheduledTask`.

#### Scenario: nuevo ticket recibe el siguiente número
- **WHEN** se crea un ticket
- **THEN** recibe un `sequenceNumber` mayor a cualquiera asignado antes; el DTO/respuesta lo expone.

#### Scenario: backfill de tickets existentes
- **WHEN** corre la migración
- **THEN** los tickets previos reciben `1..N` por `createdAt` asc (los más viejos, menor número); la secuencia queda posicionada tras el máximo.

### Requirement: REQ-TKT-2 — La lista de tickets muestra `#sequenceNumber` linkeado
#### Scenario: columna ID
- **WHEN** se renderiza la lista de tickets
- **THEN** la columna de ID muestra `#${sequenceNumber}` como link al detalle (no el `id` uuid crudo).

### Requirement: REQ-TKT-3 — La lista espeja el layout de tareas
#### Scenario: single-column con filtros horizontales
- **WHEN** se abre la lista de tickets
- **THEN** el layout es header → **barra de filtros horizontal** (arriba, filtros visibles + chips de activos) → **tabla full-width**, igual que `SchedulingTasksPage` (se elimina el panel de filtros lateral derecho).

### Requirement: REQ-TKT-4 — Prioridad como pill color-coded
#### Scenario: pill de prioridad
- **WHEN** se muestra la prioridad de un ticket en la tabla
- **THEN** se renderiza como pill con color (no texto plano), reusando el patrón de `TasksTableView`.

## Out of scope
- Rediseño del detalle del ticket (`TicketDetailPage`) — solo la lista.
- Vista kanban de tickets; cambiar el modelo de status/paginación.
- El toggle de "ocultar filtros" (se eligió "como las tareas": visibles).
