# Proposal — tickets-redesign-sequence (#11)

Mode: interactive · Store: hybrid (openspec + engram `sdd/tickets-redesign-sequence/*`).

## Why

Backlog #11: rediseñar la página de tickets **"como las tareas — moderno y lindo"** (dirección del usuario), agregar un **ID autoincremental** legible (hoy se muestra el `id` crudo) y reordenar los filtros. La página de tickets quedó vieja vs la de tareas (que tiene barra de filtros horizontal, pills de prioridad, `#número` linkeado, ColumnSelector). El worktree `tickets-redesign-fe` está desactualizado (~7200 líneas atrás) → se descarta, arrancamos de `main`.

## Decisiones (dirección del usuario: "como las tareas")

- **AD-1 — Espejar el diseño de tareas** (`SchedulingTasksPage`): layout single-column (header → **barra de filtros horizontal** arriba → tabla full-width), en vez del layout actual de tickets (tabla izquierda + panel de filtros a la derecha).
- **AD-2 — ID autoincremental**: nueva columna `sequenceNumber` en `Ticket` (Int, autoincrement/secuencial, `@unique`), como `ScheduledTask.sequenceNumber`. Migración + backfill por `createdAt` asc. El DTO la expone; el FE muestra `#${sequenceNumber}` linkeado.
- **AD-3 — Paridad visual**: prioridad como **pills** color-coded (hoy texto plano), estado con su color del catálogo, `ColumnSelector` (ya importado). Reusar el patrón/estilos de `TasksTableView`/`TaskFilterBar`.

## What changes

### Backend
- `Ticket` += `sequenceNumber Int @unique` (secuencial). Migración aditiva + backfill (asignar 1..N por `createdAt` asc a los tickets existentes). DTO de ticket expone `sequenceNumber`.
- (A confirmar) ¿autoincrement nativo de Postgres o el patrón de `ScheduledTask`? Reusar el mismo patrón que tareas para consistencia.

### Frontend
- `TicketsListPage`: reestructurar a single-column (header → filtros horizontales → tabla full-width), espejando `SchedulingTasksPage`.
- `TicketFilterBar`: pasar de panel vertical (derecha) a **barra horizontal** arriba (variante ya existe), con chips de filtros activos como tareas.
- Tabla: `#${sequenceNumber}` linkeado como ID, pills de prioridad, alinear columnas con el catálogo de tareas donde aplique.
- `Ticket` TS type += `sequenceNumber`.

## Puntos a confirmar (dejo un default; decime)
1. **Filtros**: el #11 original decía *"ocultos, mostrar al clickear un botón"*, pero "como las tareas" = **barra horizontal con filtros visibles** (las tareas NO los ocultan). Default: **como las tareas (visibles en barra horizontal)**. ¿O querés el toggle de ocultar igual?
2. **Scope**: ¿rediseñamos solo la **LISTA** de tickets ahora, o también el **detalle** (`TicketDetailPage`)? Default: **solo la lista** (lo más visible); el detalle aparte si querés.
3. **`sequenceNumber`**: arranca en 1, backfill por fecha de creación. ¿OK?

## Impact / Out of scope
- **Out of scope** (salvo que pidas): vista kanban de tickets; rediseño del detalle (si elegís solo lista); cambiar el modelo de status/paginación.
- **Riesgo**: medio. Rediseño FE grande (visual — el "lindo" se valida con Playwright, no solo tests). Migración aditiva + backfill idempotente. El `sequenceNumber` no rompe el routing (sigue por `id`).
- **TDD parcial**: los tests cubren estructura/comportamiento (se muestra `#número`, filtros funcionan, pills); la estética se verifica visual.
