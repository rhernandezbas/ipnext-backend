# tasks-bulk-archive (#86)

## Why
El #85 definió el patrón en TICKETS: acciones masivas con Archivar (la cerrada se va a una page de Archivados) + Eliminar solo para super admin + la vista principal muestra solo abiertas. Hay que replicar ese patrón en TAREAS (scheduling), que viven en DOS páginas (Tareas clientes + Tareas Nodos del #40) y se cuentan en Proyectos.

El #41 ya dio el estado general (`generalStatus` open/closed/dismissed) y el default "Abiertas" en la lista. Tareas YA tiene un `BulkActionBar` (Mover etapa / Cerrar / Eliminar). Falta: Archivar (con su page), Asignar y Cambiar estado masivos, y gatear el Eliminar a super admin de verdad.

## What
- **BE (aditivo):**
  - `ScheduledTask.archivedAt DateTime?` (flag aditivo, migración timestamp). Ortogonal al estado: una tarea cerrada que se archiva sigue cerrada, solo gana `archivedAt`.
  - Use case `ArchiveTask`: pre-condición la tarea debe estar cerrada o descartada (`generalStatus !== 'open'`), si no → 422 `TASK_NOT_CLOSED`. `POST /api/scheduling/:id/archive` gateado `scheduling.write`.
  - `listTasks` excluye archivadas por default (`archivedAt = null`); nuevo filtro `?archived=true` para listarlas.
  - `DELETE /:id` (hoy SIN guard granular — bug latente) pasa a gatearse con la nueva acción `scheduling.hard_delete`, que solo posee super_admin. Borrado total.
- **FE:**
  - `BulkActionBar` de tareas gana: Asignar (`scheduling.write`), Cambiar estado general (`scheduling.write`), Archivar (`scheduling.write`). Migra el bulk a `mapWithConcurrency(5)` + DataTable controlado (clear externo).
  - Eliminar se gatea con `scheduling.hard_delete` (super_admin via sentinel `*`).
  - Page nueva `/admin/scheduling/archivadas` (`scheduling.read`) que lista `?archived=true`.
  - Vista principal sigue mostrando solo abiertas (default del #41); cerrar/archivar saca la tarea al instante (invalidación).

## Permisos (dos capas)
- `scheduling.write` para Archivar / Asignar / Cambiar estado masivos (ya existe, FE+BE).
- `scheduling.hard_delete` (NUEVA acción RBAC, aditiva en `KNOWN_ACTIONS`) para Eliminar. Solo super_admin la posee (sentinel `*`). FE `useCan('scheduling.hard_delete')` + BE `requirePerm('scheduling','hard_delete')`.

## Wire contract
- `ScheduledTask` (entity + DTO) gana `archivedAt: string | null` (aditivo).
- `TaskListFilter` gana `archived?: boolean`; sin el param, listado igual que antes salvo que ahora excluye archivadas (cambio de comportamiento acotado a una columna nueva que arranca toda en null → no rompe data existente).
- `POST /api/scheduling/:id/archive` nuevo. `DELETE /api/scheduling/:id` ahora con guard.

## Proyectos
`SchedulingProjectsPage` no renderiza filas de tareas (lista proyectos). Las archivadas no necesitan ocultarse ahí. El `archiveTask` mutation invalida `PROJECTS_KEY` para que los contadores por proyecto bajen.
