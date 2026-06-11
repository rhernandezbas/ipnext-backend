# Exploration: tickets-list-redesign (#46)

## Current State

`/admin/tickets/opened` es `TicketsListPage.tsx` (origin/main). Después de #11 el layout es:

- Header row: breadcrumb + título + botones (ColumnSelector, Refresh, Crear ticket)
- Status tabs (catalog-driven): Todos | Abierto | Pendiente | Resuelto | Cerrado...
- `TicketFilterBar` siempre visible, horizontal: Estado / Prioridad / Asignado / Búsqueda / Desde / Hasta + ActiveFilterChips
- `DataTable<Ticket>` con columnas configurables + paginación
- El `DataTable` ya soporta `selectable={true}` + `onSelectionChange` — la infraestructura de checkboxes existe
- Sin `BulkActionBar` en tickets; la selección no dispara ninguna acción hoy

La `TicketFilterBar` ya tiene un `variant` prop (`'horizontal' | 'vertical'`) pero el `'vertical'` es un panel fijo (no colapsable). No existe patrón de disclosure/colapsable en ningún otro lugar del codebase que sea reutilizable.

### Seam crítico con #44 (worktree ticket-detail-fe, SIN mergear)

`Ticket.id` pasó de `number` a `string` (UUID). En origin/main el id es `number`, en el worktree #44 es `string`. Esto afecta:

- `src/types/ticket.ts` — `id: string` (worktree) vs `id: number` (main)
- `src/api/tickets.api.ts` — `getTicketById(id: string)` (worktree) vs `(id: number)` (main)
- `src/hooks/useTickets.ts` — `useDeleteTicket` manda `String(row.id)` hoy, pero los `Link` en la tabla usan `row.id` como number en main
- `customerId` también cambió: `string` en worktree vs `number` en main

**#46 aterriza después de mergear #44.** Asumir `Ticket.id: string` al escribir el código.

También #44 agrega:
- `RelatedTask` interface y campo `tasks?: RelatedTask[]` en `Ticket`
- `ticketComments.api.ts` + `ticketComments.ts` (nuevos archivos)
- `closeTicket` endpoint cambia de `DELETE /:id` a `POST /:id/close` en la api — ya está en el worktree

## Affected Areas

### FE — origin/main (base de trabajo de #46)
- `src/pages/tickets/TicketsListPage.tsx` — página principal; refactorizar a TicketsListPageBase pattern similar a tareas
- `src/pages/tickets/TicketsListPage/components/TicketFilterBar.tsx` — convertir horizontal a colapsable (disclosure)
- `src/pages/tickets/TicketsListPage/components/TicketFilterBar.module.css` — nuevos estilos para disclosure panel
- `src/pages/tickets/TicketsListPage.module.css` — ajustes de layout
- `src/hooks/useTickets.ts` — agregar `useBulkCloseTickets`, `useBulkAssignTickets`, `useBulkUpdatePriority`
- `src/api/tickets.api.ts` — NO existe endpoint bulk en BE; bulk será N requests secuenciales con `mapWithConcurrency` (mismo patrón que bulk close de tareas en `TasksTableView`)

### BE — no se necesita cambio de rutas para acciones básicas
- `src/infrastructure/http/routes/tickets.routes.ts` — NO hay endpoint bulk hoy; bulk = N llamadas a endpoints existentes. Si se quiere un endpoint bulk en BE es work adicional (ver Approaches).

### Referencia de patrón masivas
- `src/pages/scheduling/SchedulingTasksPage/components/TasksTableView.tsx` — `BulkActionBar` component, `onClose` hace N `closeTask.mutateAsync`, `onDelete` hace N `deleteTask.mutateAsync`
- `src/components/organisms/DataTable/DataTable.tsx` — ya soporta `selectable` + `onSelectionChange`

## Acciones masivas disponibles (basado en endpoints BE existentes)

| Acción | Endpoint | Permiso | Notas |
|--------|----------|---------|-------|
| Cerrar | `POST /tickets/:id/close` | `tickets.close` | N llamadas secuenciales |
| Cambiar estado | `PATCH /tickets/:id/status` | `tickets.write` | N llamadas; catálogo-driven |
| Asignar | `PATCH /tickets/:id` `{ assigneeId }` | `tickets.write` | N llamadas |
| Cambiar prioridad | `PATCH /tickets/:id` `{ priority }` | `tickets.write` | N llamadas |
| Eliminar | `DELETE /tickets/:id` | `tickets.delete` | N llamadas; BE = soft-close |

**No existe endpoint `POST /tickets/bulk/*` en el BE.** El patrón de tareas (#41) también hace N requests secuenciales para close/delete (con `for...of await`). Solo `bulk/stage` en tareas tiene endpoint dedicado porque necesita lógica de IClass. Para tickets no hay IClass, así que N requests es suficiente.

## Approaches

### Approach 1 — TicketsListPageBase refactor + BulkActionBar inline (recomendado)

Extraer `TicketsTableView` de `TicketsListPage`, análogo a cómo `TasksTableView` está separado de `SchedulingTasksPage`. El `BulkActionBar` de tickets se hace inline en `TicketsTableView` (no componente compartido).

Filtros colapsables: nuevo `TicketFilterDisclosure` — botón "Filtros" con badge count, un `<details>` o `useState` interno. El contenido interior es el `TicketFilterBar` actual (reutilizado, sin borrar el `vertical` variant que puede servir en el futuro). ActiveFilterChips permanecen SIEMPRE visibles (bajo la toolbar), así el usuario ve sus filtros activos sin abrir el panel.

- **Pros**: máximo reuse de DataTable existente, BulkActionBar y patrón de checkboxes ya probados en tareas; filtros colapsables sin nueva dependencia; cambio quirúrgico
- **Cons**: crea un componente `TicketsTableView` nuevo (poca duplicación, pero necesario para separar concerns)
- **Effort**: Medium

### Approach 2 — Refactor total + endpoint bulk en BE

Crear `POST /tickets/bulk/close`, `POST /tickets/bulk/status`, etc. en el BE con patrón análogo a `bulk/stage` de tareas.

- **Pros**: transaccional en BE, un solo round-trip
- **Cons**: scope mayor (BE + FE), las acciones de tickets no tienen requisitos de atomicidad como IClass; overkill para esta feature
- **Effort**: High

### Approach 3 — Disclosure con Radix UI / Headless UI

Usar `@radix-ui/react-collapsible` o `@headlessui/react` para el disclosure.

- **Pros**: accesible out-of-the-box
- **Cons**: nueva dependencia; el codebase no usa Radix/Headless actualmente; el patrón de `useState` + CSS transition es suficiente
- **Effort**: Low-Medium

## Recommendation

**Approach 1**. Extraer `TicketsTableView` de `TicketsListPage` con `BulkActionBar` inline. Para los filtros ocultos: nuevo `TicketFilterDisclosure` wrapper — botón pill "Filtros (N)" con badge cuando hay activos, toggle `open` con `useState`, panel con `max-height` CSS transition para una apertura suave. No hace falta Radix. N-requests bulk con `for...of await` (misma mecánica que tareas).

Acciones masivas a incluir (MVP):
1. **Cerrar** — `POST /tickets/:id/close` para cada id seleccionado (`tickets.close`)
2. **Cambiar estado** — dialog con select de catálogo, `PATCH /tickets/:id/status` (`tickets.write`)
3. **Asignar** — dialog con select de admins, `PATCH /tickets/:id` `{ assigneeId }` (`tickets.write`)
4. **Eliminar** — `DELETE /tickets/:id` gateado por `tickets.delete`

Prioridad (puede ser criterio para tareas de #46):
- MVP: Cerrar + Eliminar (análogo directo a tareas)
- V2: Cambiar estado + Asignar (más poder, más UI en el dialog)

## Risks

1. **id: string vs id: number** — #46 depende de que #44 esté mergeado. Si #46 arranca antes, el `Ticket.id` es `number` en main y todos los string-based endpoints fallan. Verificar que `feat/44-ticket-comments` mergeó antes de abrir la branch de #46.
2. **VALID_STATUSES whitelist en BE** — `tickets.routes.ts` línea 59 tiene `const VALID_STATUSES = ['open', 'pending', 'closed']`. El `PATCH /:id/status` valida contra esa lista estática. Cualquier status de catálogo custom (ej: "Resuelto") que no esté en esa lista será rechazado con 400. Esto es un bug latente que afecta la acción masiva "Cambiar estado". Se debe parchar en el mismo PR o preavisar.
3. **Bulk sin endpoint dedicado** — N requests puede ser lento con selecciones grandes (>50 tickets). Mitigación: limitar selección o usar `mapWithConcurrency` con limit=5 (ya existe en `src/application/util/mapWithConcurrency.ts`).
4. **TicketFilterBar variant vertical** — el variant `vertical` ya existe pero no se usa activamente. Al reemplazar horizontal por disclosure, hay que no romper el variant (puede ser útil para mobile/sidebar futuro).
5. **`customerId: string` seam** — en main es `number`, en #44 es `string`. Si `TicketsListPage` pasa `customerId` a filtros o links, revisar el casting.

## Ready for Proposal

Sí — el cambio está bien acotado. Proponer: (1) extraer `TicketsTableView` + `BulkActionBar`; (2) refactorizar `TicketFilterBar` a colapsable vía `TicketFilterDisclosure`; (3) N-request bulk actions para cerrar/asignar/eliminar. Dependencia explícita: mergear #44 primero (id: string).
