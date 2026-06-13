# Design — tasks-bulk-archive (#86)

## Modelo: archivado como flag, no como estado
`archivedAt: DateTime?` es ORTOGONAL a `generalStatus`. Una tarea archivada conserva su `generalStatus` (closed/dismissed). No se agrega un cuarto valor de estado. Ventajas: no toca la máquina de estados del #41, no afecta el cierre auto por flujo IClass, y el "des-archivar" es trivial (setear `archivedAt = null`).

`@@index([archivedAt])` para que el filtro default (`archivedAt IS NULL`) en las listas operativas sea eficiente.

## Pre-condición de archivar
`ArchiveTask` valida `task.generalStatus !== 'open'` (cerrada o descartada). Si está abierta → `TaskNotClosedError` → 422 `TASK_NOT_CLOSED`. Razón: archivar es el paso terminal después de cerrar; archivar algo abierto lo sacaría de la vista sin haberlo resuelto. El FE deshabilita el botón Archivar si hay alguna tarea abierta en la selección y muestra el motivo.

Idempotente: archivar una ya archivada es no-op (devuelve la tarea).

## Filtro default excluye archivadas
`listTasks(filter)`:
- `filter.archived === true` → `WHERE archivedAt IS NOT NULL` (la page de Archivadas).
- `filter.archived` ausente/false → `WHERE archivedAt IS NULL` (todas las listas operativas: Tareas clientes, Tareas Nodos, calendario, contadores de proyecto).

Esto saca las archivadas de TODAS las vistas operativas sin tocar cada caller. Como la columna arranca toda en NULL, el comportamiento para data existente es idéntico al de hoy.

## Eliminar = super_admin via acción dedicada
El FE no tiene `hasRole('super_admin')` en lógica de negocio — el único mecanismo es el sentinel de permiso `*` (super_admin recibe `['*']` y `useCan(x)` siempre true). Para "solo super admin" creamos la acción RBAC `scheduling.hard_delete`:
- Aditiva en `KNOWN_ACTIONS` (rbac.ts), sin ALTER TYPE (la columna action es VARCHAR).
- BE: `DELETE /api/scheduling/:id` gateado `requirePerm('scheduling','hard_delete')`. Hoy ese endpoint NO tiene guard granular (cualquier autenticado borra) → este cambio cierra ese bug latente.
- FE: el botón Eliminar del BulkActionBar se gatea con `useCan('scheduling.hard_delete')`. Como ningún rol del seed salvo super_admin tiene esa acción, queda efectivamente solo-super-admin, explícito y auto-documentado. (El bulk delete de tareas hoy usa `scheduling.bulk_delete`; se migra a `hard_delete`.)

Confirm fuerte en el FE antes del delete (modal con conteo + texto de irreversibilidad).

## Acciones masivas (FE)
Tareas YA tiene `BulkActionBar` con Mover etapa / Cerrar (`scheduling.write`) / Eliminar. Se agrega:
- **Asignar**: picker de usuario → `updateTask(id, { assigneeId })` por ítem.
- **Cambiar estado**: picker de generalStatus (open/closed/dismissed) → `setTaskGeneralStatus(id, status)` por ítem.
- **Archivar**: `archiveTask(id)` por ítem; deshabilitado si la selección tiene tareas abiertas.

Todas migran al patrón de tickets: `mapWithConcurrency(5)`, fallo parcial deja SOLO los fallidos seleccionados, DataTable pasa a controlado (`selectedIds` + clear externo).

## Tareas Nodos y Proyectos
- Tareas Nodos (`SchedulingNodeTasksPage` via `TasksPageBase kind="network"`) comparte `TasksTableView` → hereda automáticamente las acciones nuevas y el filtro archived.
- `SchedulingProjectsPage` no muestra filas de tareas; las archivadas no aparecen ahí. El mutation de archivar invalida `PROJECTS_KEY` para recalcular contadores.

## Page de Archivadas
`SchedulingArchivedTasksPage` reusa `TasksTableView` (read-mostly) con `listTasks({ archived: true })`. Ruta `/admin/scheduling/archivadas` (`scheduling.read`). Permite des-archivar (opcional, follow-up) — MVP: listar + ver detalle.

## Tests (TDD, targeted)
- BE: `ArchiveTask.test.ts` (in-memory: pre-condición closed, idempotencia, archivedAt seteado), `scheduling.archive.routes.test.ts` (POST /:id/archive 200/422 + DELETE guard 403/200 por permiso), `ListTasksFilter` extendido (archived default excluye). Composition guard del wiring.
- FE: `TasksTableView.bulk.test.tsx` extendido (Asignar/Cambiar estado/Archivar, gate hard_delete), test de `SchedulingArchivedTasksPage`.
