# Tasks — tasks-bulk-archive (#86)

## BE (ipnext-backend, worktree feat/86-tasks-bulk-archive)
- [ ] Migración aditiva `2026071400000X_scheduled_task_archived_at`: `ALTER TABLE "ScheduledTask" ADD COLUMN "archivedAt" TIMESTAMP(3)` + `CREATE INDEX` en archivedAt. Sin BEGIN/COMMIT.
- [ ] `prisma/schema.prisma`: `archivedAt DateTime?` + `@@index([archivedAt])` en ScheduledTask.
- [ ] `domain/entities/scheduling.ts`: `archivedAt: string | null` en `ScheduledTask`.
- [ ] `domain/entities/rbac.ts`: agregar `'hard_delete'` a `KNOWN_ACTIONS`.
- [ ] `domain/errors/`: `TaskNotClosedError` (o reutilizar uno tipado) → 422 `TASK_NOT_CLOSED`.
- [ ] `domain/ports/SchedulingRepository.ts`: `archiveTask(id): Promise<ScheduledTask | null>` + `TaskListFilter.archived?: boolean`.
- [ ] `application/dto/scheduling.dto.ts`: `archived` en `ListTasksFilterSchema`.
- [ ] `application/use-cases/ArchiveTask.ts`: valida generalStatus !== 'open', setea archivedAt, idempotente.
- [ ] Adapter Prisma `SchedulingRepository`: mapear `archivedAt` en toTask; `listTasks` default `archivedAt = null`, `archived=true` → not null; `archiveTask` update.
- [ ] Adapter in-memory `SchedulingRepository`: misma lógica.
- [ ] `http/routes/scheduling.routes.ts`: `POST /:id/archive` (auth + scheduling.write), `DELETE /:id` guard `scheduling.hard_delete`.
- [ ] `http/app.ts`: instanciar `ArchiveTask`, inyectar al router + guard hard_delete.
- [ ] Tests: ArchiveTask.test.ts, scheduling.archive.routes.test.ts, ListTasksFilter archived, composition guard.
- [ ] `npx tsc --noEmit` + suites targeted scheduling verdes.

## FE (ipnext-frontend, worktree tasks-bulk-archive)
- [ ] `types/scheduling.ts`: `archivedAt: string | null`.
- [ ] `api/scheduling.api.ts`: `archiveTask(id)` → POST /:id/archive; `buildFilterParams` pasa `archived`.
- [ ] `hooks/useScheduling.ts`: `useArchiveTask` (invalida tasks + PROJECTS_KEY + detail).
- [ ] `TasksTableView.tsx` BulkActionBar: agregar Asignar, Cambiar estado, Archivar; Eliminar → `useCan('scheduling.hard_delete')`; migrar a mapWithConcurrency(5) + DataTable controlado.
- [ ] `SchedulingArchivedTasksPage` nueva: lista `archived:true`, reusa TasksTableView.
- [ ] `App.tsx`: ruta `/admin/scheduling/archivadas` (scheduling.read). Link en sidebar/tareas.
- [ ] Tests: TasksTableView.bulk extendido, ArchivedTasksPage.
- [ ] `npm run typecheck` + suites targeted scheduling verdes.

## Cierre
- [ ] Commits por repo (conventional, sin co-author). git add por PATH explícito + verificar. NO push, NO commit en main.
- [ ] mem_save engram con resultado final.
