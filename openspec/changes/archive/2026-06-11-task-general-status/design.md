# Design: Task General Status (open / closed / dismissed) — #41

Baseline: **origin/main de ambos repos** (#40 BE mergeado en PR #104; #40b FE se mergea ANTES del apply — diseño asume #40b en main). Line refs = origin/main BE (worktree `tareas-nodos-be`) y #40b FE (worktree `tareas-nodos-fix-fe`).

## Architecture Decisions

| # | Decision | Alternatives | Rationale |
|---|----------|--------------|-----------|
| D1 | `generalStatus String @default("open")` como única verdad; `isClosed` = facade derivado | dos booleans; rename breaking | 12 tests pinned quedan verdes; enum limpio; sin constraint de doble boolean |
| D2 | **POST** `/:id/status` (no PATCH, no campo en PUT) | PATCH /:id/status; PUT field | `PATCH /:id/status` está **pineado como 404** en `scheduling-composition.test.ts:237` (ruta legacy removida — Phase 3). PUT /:id no tiene permiso hoy; gate per-field es sucio. Patrón CloseTicket |
| D3 | FE-default: BE omitido ≡ `all`; FE siempre manda `status` explícito (default `open`) | BE-default open | No rompe crons/callers existentes; rollout sin flag |
| D4 | Precedencia: `generalStatus`/`status` GANA sobre `isClosed` legacy (update body y list filter) | error 400 si ambos | back-compat silenciosa, contrato simple |
| D5 | Filtro legacy `?isClosed=` se remapea a `generalStatus` en el WHERE (ningún read path toca la columna; la columna se sincroniza on-write solo para ops) | WHERE sobre columna | imposibilita drift visible; `isClosed=false` ≡ `generalStatus != 'closed'` (incluye dismissed — preserva semántica booleana) |
| D6 | Dismissed excluido del loop IClass vía WHERE en `listTasksInIClassStage` + guards en `processSummary`; el mirror SIEMPRE se ingesta | excluir el mirror | cubre ListInFlightTasks + Backfill con un solo punto; auditoría del SO se conserva |
| D7 | FE: `useCloseTask` se re-implementa sobre el endpoint nuevo (firma intacta → call sites sin tocar) | dejar PUT isClosed | un solo writer FE, gateado por scheduling.write, eventos string |
| D8 | No-op idempotente: status igual → 200 sin evento de actividad | 409 | acción re-clickeable, sin ruido en el feed |
| D9 | URL omite `status` cuando es `open` (default se re-deriva al leer); el fetch SIEMPRE lleva `status` | siempre en URL | URLs limpias; `clearFilter` vuelve a open gratis |

## Wire Contract (FROZEN — ambos applies construyen contra esto)

```
GET /api/scheduling?status=open|closed|dismissed|all
  - omitido ≡ all (back-compat). Inválido → 400 VALIDATION_ERROR.
  - combinable con kind/projectId/etc. Si viene también isClosed: status gana.

POST /api/scheduling/:id/status          [auth + requirePerm('scheduling','write')]
  body: { "status": "open" | "closed" | "dismissed" }
  200 → Task DTO completo (con generalStatus + isClosed derivado)
  400 VALIDATION_ERROR (zod) | 401 | 403 (sin permiso) |
  404 TASK_NOT_FOUND | 422 INVALID_GENERAL_STATUS (validación defensiva del use case)
  Idempotente: mismo status → 200, sin evento.

Task DTO: + generalStatus: 'open'|'closed'|'dismissed'; isClosed se mantiene (≡ generalStatus==='closed').
PUT /api/scheduling/:id: acepta generalStatus (opcional) y isClosed (legacy). Ambos → generalStatus gana.
Activity: status_changed con fromValue/toValue STRING para escrituras nuevas; payloads boolean legacy siguen renderizando.
```

## BE — File Changes

| File | Change |
|------|--------|
| `prisma/schema.prisma` (~1166, junto a isClosed) | `generalStatus String @default("open")` |
| `prisma/migrations/20260624000000_task_general_status/migration.sql` | ver abajo |
| `src/domain/entities/scheduling.ts` | `export type TaskGeneralStatus = 'open'\|'closed'\|'dismissed'`; campo `generalStatus: TaskGeneralStatus` (junto a isClosed:55) |
| `src/domain/errors/scheduling.ts` | `InvalidGeneralStatusError` code `INVALID_GENERAL_STATUS` |
| `src/domain/ports/SchedulingRepository.ts` | `CreateTaskInput`: agregar `'generalStatus'` al Omit (línea 7) — siempre nace open. `UpdateTaskInput`: `generalStatus?: TaskGeneralStatus` (línea 21) |
| `src/application/dto/scheduling.dto.ts` | base schema ~74: `generalStatus: z.enum(['open','closed','dismissed']).optional()` (UpdateTaskSchema lo hereda). `ListTasksFilterSchema` ~132: `status: z.enum(['open','closed','dismissed','all']).optional()` |
| `src/application/use-cases/SetTaskGeneralStatus.ts` | NUEVO (template: SetTaskInventoryReview) |
| `src/application/use-cases/UpdateTask.ts` | normalización pre-snapshot (ver abajo) |
| `src/application/use-cases/computeUpdateTaskActivities.ts` | línea 51 → branch dual (ver abajo) |
| `src/application/use-cases/IngestClosedServiceOrders.ts` | guards dismissed en `processSummary` |
| `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts` | toTask:89, listTasks:184+, _buildUpdateData:545, listTasksInIClassStage:671 |
| `src/infrastructure/adapters/in-memory/InMemorySchedulingRepository.ts` | NEW_FIELDS_DEFAULTS:69, listTasks:290+, createTask:343, updateTask:400, listTasksInIClassStage:517 |
| `src/infrastructure/http/routes/scheduling.routes.ts` | GET / rawQuery + `status`; POST /:id/status (registrada ANTES de GET /:id); 2 params nuevos al final |
| `src/infrastructure/http/app.ts` | wiring (ver abajo) |

### Migración (sin BEGIN/COMMIT, idempotente, timestamp > 20260623000000)

```sql
-- Migration: task_general_status (#41)
-- Additive: ADD COLUMN ... DEFAULT es metadata-only en PG. Backfill idempotente desde isClosed.
ALTER TABLE "ScheduledTask"
  ADD COLUMN IF NOT EXISTS "generalStatus" TEXT NOT NULL DEFAULT 'open';

UPDATE "ScheduledTask" SET "generalStatus" = 'closed'
  WHERE "isClosed" = true AND "generalStatus" <> 'closed';
```

Verificación: `count(isClosed=true) == count(generalStatus='closed')`.

### Facade — líneas exactas

**Derive-on-read** — `PrismaSchedulingRepository.toTask` línea 89, reemplazar `isClosed: row.isClosed ?? false,` por:

```ts
// #41 — generalStatus es la verdad; isClosed derivado. Fallback legacy-row (tests pinned pasan rows sin la columna).
generalStatus: (row.generalStatus ?? (row.isClosed ? 'closed' : 'open')) as TaskGeneralStatus,
isClosed: (row.generalStatus ?? (row.isClosed ? 'closed' : 'open')) === 'closed',
```

In-memory no tiene toTask: el objeto almacenado mantiene AMBOS campos consistentes en cada write (equivalente del derive).

**Sync-on-write** (la columna isClosed solo para ops tooling):
- Prisma `_buildUpdateData` línea 545 — reemplazar `if (data.isClosed !== undefined) update['isClosed'] = data.isClosed;` por:
```ts
const gs = data.generalStatus ?? (data.isClosed !== undefined ? (data.isClosed ? 'closed' : 'open') : undefined);
if (gs !== undefined) { update['generalStatus'] = gs; update['isClosed'] = gs === 'closed'; }
```
- In-memory `updateTask` línea 400 — reemplazar el spread de isClosed por el mismo cómputo seteando `generalStatus` + `isClosed` juntos.
- Create: Prisma no setea nada (default DB); in-memory agrega `generalStatus: 'open'` en NEW_FIELDS_DEFAULTS:69 y createTask:343.
- La normalización vive en repo Y use case: los tests pinned llaman `repo.updateTask(id, {isClosed:true})` directo.

**Único writer de isClosed — VERIFICADO en origin/main**: las únicas escrituras son `_buildUpdateData:545` (Prisma) y `updateTask:400` (in-memory), alcanzables solo vía `repo.updateTask` ← `UpdateTask` ← `PUT /:id`. `IngestClosedServiceOrders` NUNCA toca isClosed (solo `moveTaskToStage` + `markClosureCompleteness`). No hay otro path que mapear.

### UpdateTask — normalización (orden de precedencia)

En `UpdateTask.execute`, antes del snapshot (línea ~72):
```ts
// #41 — isClosed legacy → generalStatus. generalStatus explícito GANA si vienen ambos.
if (data.generalStatus === undefined && data.isClosed !== undefined) {
  data = { ...data, generalStatus: data.isClosed ? 'closed' : 'open' };
}
```

`computeUpdateTaskActivities` línea 51 → branch dual, UN solo evento:
```ts
if (changed('generalStatus')) events.push({ type: 'status_changed', actor, fromValue: prev.generalStatus, toValue: data.generalStatus });
else if (changed('isClosed')) events.push({ type: 'status_changed', actor, fromValue: prev.isClosed, toValue: data.isClosed });
```
El test pinned (`computeUpdateTaskActivities.test.ts:112`, boolean) llama al diff directo sin generalStatus → branch legacy → verde, intacto.

### SetTaskGeneralStatus (nuevo use case)

```ts
export class SetTaskGeneralStatus {
  constructor(private readonly repo: SchedulingRepository, private readonly recorder?: TaskActivityRecorder) {}
  async execute(id: string, status: string, actor?: ActorContext): Promise<ScheduledTask> {
    if (!['open','closed','dismissed'].includes(status)) throw new InvalidGeneralStatusError(status); // 422
    const prev = await this.repo.getTask(id);
    if (!prev) throw new TaskNotFoundError(id);                                                       // 404
    if (prev.generalStatus === status) return prev;                                                   // D8 no-op
    const updated = await this.repo.updateTask(id, { generalStatus: status as TaskGeneralStatus });
    if (!updated) throw new TaskNotFoundError(id);
    if (this.recorder) await this.recorder.record(id, 'status_changed', { actor: actor ?? SYSTEM_ACTOR, fromValue: prev.generalStatus, toValue: status });
    return updated;
  }
}
```

### Ruta + wiring + composition-root

`scheduling.routes.ts`: 2 params opcionales NUEVOS al final de `createSchedulingRouter` (precedente: `requireInventoryWrite`): `setTaskGeneralStatus?: SetTaskGeneralStatus, requireSchedulingWrite?: RequestHandler`. Ruta en el bloque "BEFORE /:id", gateada `auth, schedWrite` (passthrough si se omite, como invWrite):
zod `z.object({ status: z.enum(['open','closed','dismissed']) })` → 400; `TaskNotFoundError` → 404; `InvalidGeneralStatusError` → 422. GET / rawQuery agrega `status: req.query['status']`.

`app.ts` — wiring exacto:
- ~línea 737 (junto a setTaskInventoryReview): `const setTaskGeneralStatus = new SetTaskGeneralStatus(schedulingRepo, taskActivityRecorder);`
- línea 1272: `..., getTaskActivity, requirePerm('inventory', 'write'), retireContractEquipment, setTaskGeneralStatus, requirePerm('scheduling', 'write')));`

**W6 static test** — NUEVO `src/__tests__/infrastructure/task-general-status-composition.test.ts` (patrón `projects-network-flag-composition.test.ts`): (1) la ventana de `createSchedulingRouter(` en app.ts contiene `requirePerm('scheduling', 'write')`; (2) el bloque `new SetTaskGeneralStatus(` contiene `schedulingRepo` y `taskActivityRecorder`. Además, EXTENDER `scheduling-composition.test.ts`: POST /:id/status alcanzable (no shadowed) y `PATCH /:id/status` sigue 404.

### Filtro status — WHERE en ambos repos

- Prisma `listTasks`, después de línea 184: `if (filter?.isClosed !== undefined) where['generalStatus'] = filter.isClosed ? 'closed' : { not: 'closed' };` (reemplaza el WHERE por columna, D5) y luego `if (filter?.status && filter.status !== 'all') where['generalStatus'] = filter.status;` (status gana por orden).
- In-memory línea 290: isClosed ya filtra sobre el derivado; agregar `if (filter.status && filter.status !== 'all') tasks = tasks.filter(t => t.generalStatus === filter.status);`
- `ListTasks` es passthrough — sin cambios.

### IClass — exclusión dismissed

- `listTasksInIClassStage`: Prisma línea 671 `where: { stage: { is: { code: stageCode } }, generalStatus: { not: 'dismissed' } }`; in-memory línea 517 `+ && t.generalStatus !== 'dismissed'`. Cubre `ListInFlightTasks:16` y `BackfillClosedServiceOrders:103`.
- `IngestClosedServiceOrders.processSummary` — guard points exactos, `const isDismissed = task.generalStatus === 'dismissed'` tras el lookup (línea 194):
  - **G1** path unchanged (208-229): si isDismissed → `counts.skippedUnchanged++; return;` ANTES de `reconcileStuckTaskStage` y del re-intento de returns.
  - **G2** path fresh: `this.closed.upsert(order, task.id)` (265) SIEMPRE corre (mirror se ingesta); si isDismissed → saltear `moveTaskToStage` (269-271) y `runClosureSideEffects` (274), con un `console.log` informativo. Sin counter nuevo (shape de counts estable).

## FE — File Changes (#41 aterriza SOBRE #40b en main)

| File | Change |
|------|--------|
| `src/types/scheduling.ts` | `TaskGeneralStatus`; `ScheduledTask.generalStatus`; `TaskListFilter.status?: TaskGeneralStatus \| 'all'` |
| `src/api/scheduling.api.ts` | `buildFilterParams`: `if (filter?.status) params['status'] = filter.status;`; nuevo `setTaskGeneralStatus = (id, status) => axiosClient.post(\`${BASE}/${id}/status\`, { status })`. NO tocar el deprecated `updateTaskStatus` (fuera de scope) |
| `src/hooks/useScheduling.ts` | nuevo `useSetTaskGeneralStatus()` (invalida `['scheduling-tasks']`, `['scheduling-task', id]`, `['task-activity', id]` + PROJECTS vía `invalidateTasksAndProjects`); `useCloseTask` re-implementado: `mutationFn: ({id, isClosed}) => api.setTaskGeneralStatus(id, isClosed ? 'closed' : 'open')` — firma intacta, call sites (TaskHeader/TasksTableView) sin tocar (D7) |
| `useTasksFilterUrl.ts` | read: `status: parseStatus(get('status')) ?? 'open'` (inválido/ausente → open). Merge: `'status' in patch ? patch.status : ...`. Write: `if (merged.status && merged.status !== 'open') next.set('status', merged.status)` (D9). `clearFilter` queda igual → vuelve a open |
| `TaskFilterBar.tsx` | select "Estado general" tras Prioridad (antes del search): Abiertas (open, default) / Cerradas / Descartadas / Todas (all). Chip cuando `status !== 'open'` ("Estado general: Cerradas"), remove → `{ status: 'open' }`. "Limpiar todo": agregar `status: 'open'` al patch |
| `TasksPageBase.tsx` | SIN cambios estructurales: `status` viaja dentro de `backendFilter` (línea 82-84) → siempre enviado. Wrappers (`index.tsx`, `SchedulingNodeTasksPage`) intactos |
| `TaskHeader.tsx` (detalle) | Badge en titleRow (donde hoy `task.isClosed && Cerrada`:142): pill por generalStatus — closed→"Cerrada", dismissed→"Descartada". Kebab (185): si open → "Cerrar tarea" + "Descartar tarea" (danger); si closed/dismissed → "Reabrir tarea". Ítems de status envueltos en `<Can permission="scheduling.write">`. Prop nueva `onSetStatus(s: TaskGeneralStatus)` reemplaza `onClose` |
| `SchedulingTaskDetailPage.tsx` | `handleClose` (243) → `handleSetStatus` con `useSetTaskGeneralStatus`; dismiss pasa por `ConfirmModal` (molecule existente): "¿Descartar esta tarea? Saldrá de las vistas principales y dejará de reconciliarse con IClass." |
| `TasksTableView.tsx` | 408-414: `closedRow` + pill por `generalStatus !== 'open'` (Cerrada/Descartada) — con default open solo aparecen bajo filtro closed/dismissed/all (cumple la regla del pill). Acción "Cerrar" (505) sin tocar (usa useCloseTask) |
| `taskActivityLabel.ts:75` | `status_changed`: `'dismissed'→'descartó la tarea'; 'closed'\|true→'cerró la tarea'; else ('open'\|false)→'reabrió la tarea'` — soporta payloads boolean legacy |

Calendar: fuera de scope (query acotada por fechas propia; no se fuerza status).

## Testing Strategy (STRICT TDD — test primero por pieza)

| Pieza | Test | Approach |
|-------|------|----------|
| Facade repos | `scheduling.generalStatus.test.ts` (nuevo, espejo del suite isClosed) | toTask deriva (row legacy sin columna / con generalStatus / dismissed); in-memory create default open; update generalStatus sincroniza isClosed; isClosed→generalStatus; precedencia generalStatus gana |
| Use case | `SetTaskGeneralStatus.test.ts` | in-memory + fake recorder: close/dismiss/reopen, 404, valor inválido → InvalidGeneralStatusError, no-op sin evento, evento string from/to |
| Seam ruta→UC→repo | supertest en el suite nuevo | POST /:id/status 200/400/403 (guard que rechaza)/404/422; GET ?status= con seed open+closed+dismissed: open/closed/dismissed/all/omitido; status gana a isClosed; status+kind combinados |
| Composition | extender `scheduling-composition.test.ts` | POST /:id/status no shadowed; **PATCH /:id/status sigue 404** |
| Composition-root W6 | `task-general-status-composition.test.ts` (estático) | requirePerm('scheduling','write') en la call de createSchedulingRouter; new SetTaskGeneralStatus( con recorder |
| Activity diff | extender `computeUpdateTaskActivities.test.ts` | evento string con generalStatus; UN solo evento si vienen ambos; caso boolean existente (línea 112) INTACTO |
| IClass | `IngestClosedServiceOrders.dismissed.test.ts` + casos en listTasksInIClassStage | dismissed: mirror upserted, sin stage move, sin side-effects, sin reconcile en unchanged; in-memory excluye dismissed |
| Pinned intactos | `scheduling.isClosed.test.ts` (12) | verdes SIN tocar (criterio de éxito) |
| FE filtro | `useTasksFilterUrl.test` / `TaskFilterBar` / `SchedulingTasksPage` | default open, omit-when-open en URL, clearFilter→open; 4 opciones + chips; fetch con status=open por default |
| FE acciones | `TaskHeader.test` / `taskActivityLabel.test` | menú por estado, Can gating, confirm de dismiss, badges; labels string+boolean+dismissed |
| Gates | `tsc` + suite Jest completa en ambos repos | — |

## Migration / Rollout (sin flag)

1. **Migración** (additiva + backfill idempotente) → 2. **Deploy BE** → 3. **Deploy FE**.
Ventana BE-nuevo/FE-viejo: FE no manda `status` → BE devuelve all = comportamiento actual; `PUT {isClosed}` sigue funcionando vía facade → **OK**. Ventana inversa (rollback BE): BE viejo ignora `?status` (rawQuery no lo lee) → lista sin filtrar; POST /:id/status → 404 (toast de error, aceptable, no corrompe). Rollback de código seguro: columna queda con default, path legacy intacto.

## Seams con #40b

- BE: #40 ya en origin/main — branch de `main`, sin seam pendiente.
- FE: archivos compartidos con #40b (`TasksPageBase`, `useTasksFilterUrl`, `TaskFilterBar`, `scheduling.api`, `types/scheduling`) — **el orquestador mergea #40b a main ANTES del apply FE**; #41 branchea de main post-merge. Todas las keys de #41 son aditivas (status, generalStatus) — sin colisión semántica con kind/hiddenColumns.

## Open Questions

Ninguna bloqueante.
