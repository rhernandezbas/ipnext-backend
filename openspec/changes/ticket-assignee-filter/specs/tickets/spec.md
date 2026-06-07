# Spec delta — ticket-assignee-filter (#25)

Capability: filtros del listado de tickets (asignado + fechas). Asegura que todos los filtros del `TicketFilterBar` apliquen.

## ADDED Requirements

### Requirement: REQ-TKTF-1 — Filtrar tickets por asignado
El listado de tickets DEBE filtrar por `assigneeId` cuando se elige un asignado, excluyendo los no-asignados.

#### Scenario: asignado elegido → solo los de ese usuario
- **WHEN** se filtra por Asignado = U
- **THEN** la lista muestra solo tickets con `assigneeId = U` (los `null`/otros quedan fuera).

#### Scenario: sin asignado elegido → todos
- **WHEN** no hay filtro de asignado
- **THEN** se listan todos (comportamiento actual).

### Requirement: REQ-TKTF-2 — Filtrar tickets por rango de fechas (createdAt)
El listado DEBE filtrar por `from`/`to` sobre `createdAt`.

#### Scenario: from y/o to
- **WHEN** se setea `from` (y/o `to`)
- **THEN** se listan solo los tickets con `createdAt >= from` y/o `createdAt <= fin del día de to`. (Solo `from`, solo `to`, o ambos.)

### Requirement: REQ-TKTF-3 — El FE manda todos los filtros
#### Scenario: el query incluye asignado y fechas
- **WHEN** hay `assignedTo`/`from`/`to` en el filtro
- **THEN** `useTicketList` los envía al backend (hoy se pierden).

## Out of scope
- Filtros de tareas (ya funcionan: assignee/priority server-side; el #27 cubre el de prioridad).
- Filtro de reporter (no existe).
