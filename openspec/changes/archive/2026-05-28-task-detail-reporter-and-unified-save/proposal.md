# Proposal: Reporter on Create + Unified Save in Task Detail

## Intent

Hoy `ScheduledTask.reporterId` se persiste solo si el cliente lo manda en el body — y ningún flujo del front lo manda — por lo que la tarjeta "Reporter" del detalle siempre dice "Sin reporter asignado" y no hay traza de quién creó cada tarea. A la vez, el detalle expone dos botones "Guardar" separados (descripción / Datos) que confunden y obligan a dos clics y dos viajes al API para un mismo cambio de tarea. Esta propuesta corrige ambos problemas y agrega visibilidad del reporter en la lista de tareas.

## Scope

### In Scope
- Backend: `POST /api/scheduling` defaultea `reporterId` al `req.user.id` cuando el body no lo trae.
- Frontend (detalle): un único "Guardar cambios" al pie que persiste descripción + Datos en una sola llamada a `updateTask`. `DescriptionEditor` pasa a controlado (`onChange`) y pierde su botón propio.
- Frontend (lista): columna "Reporter" en `TasksTableView`, resolviendo `reporterId → admin.name` client-side con el listado de admins ya disponible en la página.

### Out of Scope
- Backfill de `reporterId` en tareas existentes (no hay forma de saber quién las creó).
- Denormalizar `reporterName` en el DTO/entity/repo: el front ya tiene los admins, no hace falta tocar BE para ese nombre.
- Cambios en `assigneeId` / `watcherIds` / otros campos del header del detalle.

## Capabilities

### New Capabilities
- None

### Modified Capabilities
- `scheduling`: la creación de tarea SHALL setear `reporterId` al usuario autenticado cuando el body no lo provee. El comportamiento del body explícito (sigue ganando si viene) se mantiene.

## Approach

- BE: una sola modificación en `scheduling.routes.ts` (handler `POST /`): `reporterId: data.reporterId ?? req.user?.id ?? null`. Test del route harness ajustado: `StubLookup` admin debe conocer al usuario de la sesión.
- FE detalle: el page padre (`SchedulingTaskDetailPage`) sostiene el HTML de descripción como estado controlado y `handleFormSubmit` lo agrega al payload de `updateTask`. `DescriptionEditor` deja de tener `onSave`/botón y pasa a `onChange`.
- FE lista: `TasksTableView` acepta `technicians`/`admins` como prop opcional; la columna `reporterName` se agrega a `ALL_TASK_COLUMNS` y se incluye en el default visible.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/infrastructure/http/routes/scheduling.routes.ts` | Modified | Default reporterId al usuario autenticado |
| `src/__tests__/infrastructure/scheduling.routes.test.ts` | Modified | `StubLookup` admin con `admin-1` |
| `ipnext-frontend/src/pages/scheduling/SchedulingTaskDetailPage/**` | Modified | Save consolidado |
| `ipnext-frontend/src/pages/scheduling/SchedulingTasksPage/**` | Modified | Columna Reporter |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Existing create tests rompen porque adminLookup ahora valida un reporter no provisto | Med | Test del route ya identifica el ajuste; se hace junto al cambio |
| Reporter del front no matchea admins por id distinto | Low | Confirmado: `User.id == admin.id` en `JwtAuthAdapter`. |
| Doble dirty-state (descripción + form) descoordinado | Low | Lift state a parent + un solo handler unifica |

## Rollback Plan

Revertir los commits FE/BE por separado. El BE no toca esquema ni migra datos; el FE no rompe rutas viejas. `git revert <sha>` por repo y deploy automático restaura.

## Dependencies

- Ninguna externa. `req.user` ya disponible vía `authMiddleware` (cookie `auth_token`).

## Success Criteria

- [ ] Crear una tarea nueva via UI muestra al creador en la tarjeta Reporter del detalle.
- [ ] El detalle muestra un único botón "Guardar cambios" al pie; descripción + Datos se persisten en una sola llamada.
- [ ] La lista de tareas muestra columna "Reporter" con el nombre resuelto o "—".
- [ ] `npm test` (BE) y `npx vitest run` (FE) verdes.
- [ ] No regresiones en tareas viejas: siguen apareciendo como "Sin reporter asignado" sin romper.
