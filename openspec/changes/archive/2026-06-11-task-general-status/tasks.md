# Tasks: Task General Status (open / closed / dismissed) — #41

> Wire contract FROZEN: `POST /api/scheduling/:id/status` (POST, NOT PATCH — PATCH /:id/status pinned 404).
> `GET /api/scheduling?status=open|closed|dismissed|all` (omit ≡ all, back-compat).
> DTO: `+generalStatus: 'open'|'closed'|'dismissed'`; `isClosed` derivado (`=== 'closed'`).
> BE y FE **aplican en paralelo** (worktrees independientes) desde origin/main post-#40/#40b merge.
> Runner BE: `npx jest --runInBand` | Runner FE: `npx vitest run`

---

## Phase BE-1: Foundation — Schema, Domain, Ports, Migration

- [x] BE-1.1 [RED] `src/__tests__/infrastructure/scheduling.generalStatus.test.ts` — tests de facade: toTask con row legacy (sin columna → fallback), row con generalStatus, dismissed→isClosed=false; in-memory create default open; update generalStatus sincroniza isClosed; isClosed→generalStatus; precedencia generalStatus gana.
- [x] BE-1.2 `prisma/schema.prisma` — agregar `generalStatus String @default("open")` junto a `isClosed` (~línea 1166).
- [x] BE-1.3 `prisma/migrations/20260624000000_task_general_status/migration.sql` — `ADD COLUMN IF NOT EXISTS "generalStatus" TEXT NOT NULL DEFAULT 'open'`; backfill idempotente `UPDATE ... WHERE isClosed=true AND generalStatus<>'closed'`. Sin BEGIN/COMMIT.
- [x] BE-1.4 `src/domain/entities/scheduling.ts` — `export type TaskGeneralStatus`; campo `generalStatus: TaskGeneralStatus` junto a `isClosed`.
- [x] BE-1.5 `src/domain/errors/scheduling.ts` — `InvalidGeneralStatusError` con code `INVALID_GENERAL_STATUS`.
- [x] BE-1.6 `src/domain/ports/SchedulingRepository.ts` — `CreateTaskInput`: agregar `'generalStatus'` al Omit; `UpdateTaskInput`: `generalStatus?: TaskGeneralStatus`.
- [x] BE-1.7 `src/application/dto/scheduling.dto.ts` — base schema: `generalStatus: z.enum([...]).optional()`; `ListTasksFilterSchema`: `status: z.enum(['open','closed','dismissed','all']).optional()`.
- [x] BE-1.8 [GREEN] Implementar facade en `PrismaSchedulingRepository.toTask` (~línea 89): derive-on-read con fallback legacy-row; `_buildUpdateData` (~línea 545): sync-on-write; `listTasks` (~línea 184): WHERE por `status` gana a `isClosed`; `listTasksInIClassStage` (~línea 671): `generalStatus: { not: 'dismissed' }`.
- [x] BE-1.9 [GREEN] Implementar en `InMemorySchedulingRepository`: `NEW_FIELDS_DEFAULTS` (~línea 69) y `createTask` (~línea 343) con `generalStatus:'open'`; `updateTask` (~línea 400): sync generalStatus+isClosed; `listTasks` (~línea 290): filtro `status`; `listTasksInIClassStage` (~línea 517): excluir dismissed.

---

## Phase BE-2: Use Cases

- [x] BE-2.1 [RED] `src/__tests__/application/SetTaskGeneralStatus.test.ts` — close/dismiss/reopen, 404→TaskNotFoundError, valor inválido→InvalidGeneralStatusError, no-op sin evento (D8), evento string from/to; usar InMemorySchedulingRepository + fake recorder.
- [x] BE-2.2 [GREEN] `src/application/use-cases/SetTaskGeneralStatus.ts` — NUEVO (template: SetTaskInventoryReview). Validar enum, lookup, no-op guard, `repo.updateTask({generalStatus})`, recorder `status_changed` con string from/to.
- [x] BE-2.3 [RED] `src/__tests__/application/computeUpdateTaskActivities.test.ts` — extender: evento string con generalStatus explícito; UN solo evento si vienen ambos campos; caso boolean existente (línea 112) INTACTO.
- [x] BE-2.4 [GREEN] `src/application/use-cases/computeUpdateTaskActivities.ts` (~línea 51) — branch dual: `if (changed('generalStatus'))` → string event; `else if (changed('isClosed'))` → boolean legacy event.
- [x] BE-2.5 [RED] `src/__tests__/application/UpdateTask.test.ts` — `PUT {isClosed:true}` → `generalStatus='closed'`; `{isClosed:true, generalStatus:'dismissed'}` → dismissed gana.
- [x] BE-2.6 [GREEN] `src/application/use-cases/UpdateTask.ts` (~línea 72) — normalización pre-snapshot: `if (data.generalStatus === undefined && data.isClosed !== undefined) data = { ...data, generalStatus: data.isClosed ? 'closed' : 'open' }`.

---

## Phase BE-3: HTTP + Wiring

- [x] BE-3.1 [RED] `src/__tests__/infrastructure/scheduling-composition.test.ts` — EXTENDER: POST /:id/status alcanzable (no shadowed); PATCH /:id/status sigue 404.
- [x] BE-3.2 [RED] `src/__tests__/infrastructure/task-general-status-composition.test.ts` — NUEVO (patrón projects-network-flag-composition): (1) `createSchedulingRouter(` contiene `requirePerm('scheduling','write')`; (2) `new SetTaskGeneralStatus(` contiene `schedulingRepo` y `taskActivityRecorder`.
- [x] BE-3.3 [GREEN] `src/infrastructure/http/routes/scheduling.routes.ts` — 2 params al final: `setTaskGeneralStatus?`, `requireSchedulingWrite?`; ruta `POST /:id/status` ANTES de `GET /:id`, gateada auth+schedWrite; zod body enum; map errors→400/404/422; GET /: rawQuery incluye `status: req.query['status']`.
- [x] BE-3.4 [GREEN] `src/infrastructure/http/app.ts` — (~línea 737): `const setTaskGeneralStatus = new SetTaskGeneralStatus(schedulingRepo, taskActivityRecorder)`; (~línea 1272): extender call de `createSchedulingRouter` con `..., getTaskActivity, requirePerm('inventory','write'), retireContractEquipment, setTaskGeneralStatus, requirePerm('scheduling','write')`.

---

## Phase BE-4: IClass Guards + Integration Tests

- [x] BE-4.1 [RED] `src/__tests__/application/IngestClosedServiceOrders.dismissed.test.ts` — NUEVO: dismissed → mirror upserted, sin stage move, sin side-effects, sin reconcile en unchanged-path; run summary incluye skippedDismissed; open task → sin cambios.
- [x] BE-4.2 [RED] casos en `listTasksInIClassStage` tests — dismissed ausente, closed presente, open presente.
- [x] BE-4.3 [GREEN] `src/application/use-cases/IngestClosedServiceOrders.ts` — guard G1 en unchanged-path (~línea 208): `if (isDismissed) { counts.skippedUnchanged++; return; }` ANTES de reconcileStuckTaskStage; guard G2 en fresh-path (~línea 265): `this.closed.upsert(...)` SIEMPRE corre; `if (isDismissed)` → saltear moveTaskToStage+runClosureSideEffects + console.log.
- [x] BE-4.4 [RED] Supertest suite — `src/__tests__/infrastructure/scheduling.generalStatus.routes.test.ts`: POST /:id/status 200/400/401/403/404/422; GET ?status= con seed open+closed+dismissed: filtros individuales, all, omitido≡all, status gana a isClosed en body, status+kind combinados (escenarios REQ-GS-FILTER-1, REQ-GS-ENDPOINT-1).
- [x] BE-4.5 [GREEN] Fix cualquier error de integración revelado por BE-4.4.
- [x] BE-4.6 Verificar pinned: `npx jest --runInBand src/__tests__/infrastructure/scheduling.isClosed.test.ts` — los 12 tests verdes SIN tocar el archivo.

---

## Phase FE-1: Types, API, Hooks (paralela a BE-2/BE-3)

- [x] FE-1.1 [RED] `src/hooks/useScheduling.test.ts` o equivalente — `useSetTaskGeneralStatus` invalida scheduling-tasks + scheduling-task + task-activity + projects; `useCloseTask` llama `api.setTaskGeneralStatus(id, isClosed ? 'closed' : 'open')` (firma intacta).
- [x] FE-1.2 [GREEN] `src/types/scheduling.ts` — `TaskGeneralStatus = 'open'|'closed'|'dismissed'`; `ScheduledTask.generalStatus`; `TaskListFilter.status?: TaskGeneralStatus | 'all'`.
- [x] FE-1.3 [GREEN] `src/api/scheduling.api.ts` — `buildFilterParams`: `if (filter?.status) params['status'] = filter.status`; nuevo `setTaskGeneralStatus = (id, status) => axiosClient.post(...)`. No tocar `updateTaskStatus` deprecated.
- [x] FE-1.4 [GREEN] `src/hooks/useScheduling.ts` — nuevo `useSetTaskGeneralStatus()` con invalidaciones; `useCloseTask` re-implementado sobre `api.setTaskGeneralStatus` (firma `{id, isClosed}` intacta, call sites sin tocar).

---

## Phase FE-2: Filter URL + FilterBar

- [x] FE-2.1 [RED] `useTasksFilterUrl.test.ts` — default open, omit-when-open en URL, clearFilter→open, URL `?status=closed` → lee closed, `?status=invalid` → open.
- [x] FE-2.2 [GREEN] `useTasksFilterUrl.ts` — read: `status: parseStatus(get('status')) ?? 'open'`; write: omitir cuando `status==='open'`; merge con `'status' in patch`; clearFilter patch sin cambios → vuelve a open.
- [x] FE-2.3 [RED] `TaskFilterBar.test.tsx` — 4 opciones visibles; chip cuando status!==open; remove chip → status=open; limpiar todo → patch con status:open; sin scheduling.write → SIN chip de status (si aplica).
- [x] FE-2.4 [GREEN] `TaskFilterBar.tsx` — select "Estado general" tras Prioridad: Abierta/Cerrada/Descartada/Todos; chip cuando `status !== 'open'` con label localizado; remove → `{ status: 'open' }`; "Limpiar todo" agrega `status: 'open'` al patch.
- [x] FE-2.5 Verificar `TasksPageBase.tsx` — `status` viaja dentro de `backendFilter` (línea ~82-84) sin cambios estructurales; wrappers `index.tsx` + `SchedulingNodeTasksPage` intactos.

---

## Phase FE-3: Detail Actions + Badges + Activity

- [x] FE-3.1 [RED] `TaskHeader.test.tsx` — open: muestra Cerrar+Descartar; closed: muestra Reabrir+Descartar; dismissed: muestra Reabrir+Cerrar; sin scheduling.write → ninguna acción; dismiss dispara ConfirmModal; badge closed→"Cerrada", dismissed→"Descartada", open→sin badge.
- [x] FE-3.2 [GREEN] `TaskHeader.tsx` (~línea 142 badge, ~línea 185 kebab) — pill por generalStatus (closed/dismissed); kebab condicional por estado; items envueltos en `<Can permission="scheduling.write">`; prop `onSetStatus(s: TaskGeneralStatus)` reemplaza `onClose`.
- [x] FE-3.3 [GREEN] `SchedulingTaskDetailPage.tsx` (~línea 243) — `handleSetStatus` con `useSetTaskGeneralStatus`; dismiss pasa por `ConfirmModal` existente con copy de diseño.
- [x] FE-3.4 [RED] `TasksTableView.test.tsx` — pill cerrada/descartada en row cuando generalStatus!==open; fila cerrada mantiene estilo visual; acción Cerrar (línea 505) usa useCloseTask intacto.
- [x] FE-3.5 [GREEN] `TasksTableView.tsx` (~línea 408-414) — pill por `generalStatus !== 'open'`; `closedRow` estilo intacto.
- [x] FE-3.6 [RED] `taskActivityLabel.test.ts` — `status_changed` con toValue='dismissed'→'descartó la tarea'; 'closed'|true→'cerró la tarea'; 'open'|false→'reabrió la tarea'; boolean legacy no crashea.
- [x] FE-3.7 [GREEN] `taskActivityLabel.ts` (~línea 75) — branch dual: string `dismissed`/`closed`/`open`; fallback boolean `true`→closed label, `false`→open label.

---

## Phase GATE: Orchestrator Gates

- [ ] GATE-1 BE: `npx jest --runInBand` — suite completa verde; pinned `scheduling.isClosed.test.ts` (12 tests) verde; `PATCH /:id/status` sigue 404.
- [ ] GATE-2 FE: `npx vitest run` — suite completa verde.
- [ ] GATE-3 TypeScript: `npx tsc --noEmit` en ambos repos — 0 errores.
- [ ] GATE-4 Migración: verificar `count(isClosed=true) == count(generalStatus='closed')` en DB local.
