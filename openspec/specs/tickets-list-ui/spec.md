# Tickets List UI Specification

## Purpose

`/admin/tickets/opened` con selección múltiple, acciones masivas V1 (N requests), filtros colapsables con chips persistentes y modernización visual alineada a tareas (#41). Capability NUEVA (FE).

## Wire Contract (normativo)

| Acción | Request | Body | Permiso |
|--------|---------|------|---------|
| Asignar | `PATCH /api/tickets/:id` | `{ assigneeId: string \| null }` | `tickets.write` |
| Cambiar estado | `PATCH /api/tickets/:id/status` | `{ status: <nombre del catálogo> }` | `tickets.write` |
| Cerrar | `PATCH /api/tickets/:id/status` | `{ status: <nombre closed del catálogo vía CLOSED_SLUGS ['cerrado','closed'], fallback 'cerrado'> }` | `tickets.close` |
| Eliminar | `DELETE /api/tickets/:id` (BE = soft-close) | — | `tickets.delete` |

La UI MUST NOT llamar `POST /tickets/:id/close` (no existe en BE). La fn muerta `closeTicket` de `tickets.api.ts` MUST ser eliminada.

## Requirements

### Requirement: Selección múltiple de filas

La tabla MUST permitir seleccionar filas (DataTable `selectable`). Con ≥1 fila seleccionada MUST mostrarse una BulkActionBar con el conteo y un botón para limpiar la selección.

#### Scenario: Seleccionar muestra la barra

- GIVEN la lista con tickets
- WHEN el usuario marca 2 filas
- THEN aparece la barra con "2 tickets seleccionados" y las acciones
- AND al limpiar la selección la barra desaparece

### Requirement: Acciones masivas gateadas por permiso

La barra MUST ofrecer: Asignar (picker de admins), Cambiar estado (picker del catálogo), Cerrar, Eliminar (con confirm). Cada acción MUST estar gateada por `Can` según el wire contract: Asignar/Cambiar estado por `tickets.write`, Cerrar por `tickets.close` (consistente con el detalle, H2), Eliminar por `tickets.delete`. El confirm de Eliminar MUST aclarar que el ticket se cierra y conserva el historial (soft-close).

#### Scenario: Sin tickets.delete no hay Eliminar

- GIVEN un usuario con `tickets.write` y `tickets.close` pero sin `tickets.delete`
- WHEN selecciona filas
- THEN ve Asignar/Cambiar estado/Cerrar pero NO Eliminar

#### Scenario: Sin tickets.close no hay Cerrar

- GIVEN un usuario con `tickets.write` pero sin `tickets.close`
- WHEN selecciona filas
- THEN ve Asignar/Cambiar estado pero NO Cerrar

#### Scenario: Cerrar usa el nombre closed del catálogo

- GIVEN el catálogo contiene "Cerrado" y 3 tickets seleccionados
- WHEN confirma Cerrar
- THEN se emite `PATCH /:id/status` `{ status: "Cerrado" }` por cada id

#### Scenario: Cancelar el confirm de Eliminar

- WHEN el usuario cancela el confirm
- THEN no se emite ningún request y la selección se mantiene

### Requirement: Ejecución bulk con tolerancia a fallos parciales

Las acciones masivas MUST ejecutarse como N requests con `mapWithConcurrency` límite 5, capturando errores por ítem. Éxito total MUST mostrar toast con conteo y limpiar la selección; fallo parcial MUST mostrar toast "X de N fallaron" y dejar seleccionados SOLO los ids fallidos (para reintentar). La lista MUST refrescarse en ambos casos.

#### Scenario: Éxito total

- WHEN asigna 5 tickets y los 5 requests responden 2xx
- THEN toast "5 tickets actualizados" y selección vacía

#### Scenario: Fallo parcial conserva los fallidos

- GIVEN 5 seleccionados y 2 requests fallan
- WHEN termina el bulk
- THEN toast indica "2 de 5 fallaron" y la selección queda con los 2 ids fallidos

### Requirement: Filtros colapsables con chips persistentes

Los filtros MUST vivir en un panel colapsable (cerrado por defecto) detrás de un botón "Filtros" con badge del count de filtros activos. Los ActiveFilterChips MUST permanecer SIEMPRE visibles fuera del panel; quitar un chip MUST actualizar la lista sin abrir el panel.

#### Scenario: Colapsado por defecto con badge

- GIVEN 2 filtros activos en la URL
- WHEN carga la página
- THEN el panel está cerrado, el botón muestra badge "2" y los chips son visibles

#### Scenario: Quitar chip con panel cerrado

- WHEN el usuario quita un chip
- THEN el filtro se limpia y la lista se refresca, sin abrir el panel

### Requirement: Estados visuales

La página MUST mostrar estado de carga, y empty states diferenciados: sin tickets (copy + CTA crear) vs. sin resultados con filtros activos (copy + acción "Limpiar filtros"). Las pills de status/prioridad (#26) MUST permanecer intactas.

#### Scenario: Empty con filtros activos

- GIVEN un filtro de status sin resultados
- WHEN la lista vuelve vacía
- THEN se muestra "Sin resultados para los filtros" con acción "Limpiar filtros"
