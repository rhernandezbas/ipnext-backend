# Proposal: Reassign Project on Existing Task

## Intent

Hoy el operador puede setear `projectId` al **crear** una tarea (modal de creación), pero una vez creada **no hay forma de cambiarla desde la UI**: el `DatosForm` del detalle no renderea un select de proyectos. A la vez, ni `CreateTask` ni `UpdateTask` validan la FK `projectId` contra la base — si un cliente API manda un UUID inexistente, Prisma revienta con un error de FK sin tipar y el handler responde 500. Esta propuesta cierra ambos gaps: agrega control de proyecto editable en el detalle de la tarea y endurece la validación de FK en el backend para que `projectId` se comporte igual que `customerId`, `serviceId`, `partnerId` y compañía.

## Why Now

- **Gap funcional (FE)**: ya existe `useProjects()` y `DatosFormValues.projectId` está tipado, pero `DatosForm` no expone el campo. Los operadores no pueden corregir el proyecto de una tarea creada con el equivocado (caso real reportado en QA tras el cambio `iclass-so-type-mapping`, donde el envío a IClass depende del proyecto).
- **Gap de validación (BE)**: `CreateTask` y `UpdateTask` validan customer/service/partner/reporter/assignee/watchers contra sus `EntityLookup`s, pero NO validan project. `ReferenceKind` en `src/domain/errors/scheduling.ts` no incluye `'project'`, y `REFERENCE_TO_CODE` en `scheduling.routes.ts` tampoco mapea `project: 'PROJECT_NOT_FOUND'`. El `errorHandler` ya tiene `PROJECT_NOT_FOUND: 404` configurado — sólo falta cablear la cadena.

## Scope

### In Scope
- **BE**: extender `ReferenceKind` con `'project'`, agregar `project: 'PROJECT_NOT_FOUND'` a `REFERENCE_TO_CODE`, inyectar un `EntityLookup<Project>` en `CreateTask` y `UpdateTask`, y validar `projectId` cuando esté presente (no `null` ni `undefined`).
- **BE**: wiring en `infrastructure/http/app.ts` y en el test harness para proveer el nuevo lookup (Prisma + in-memory + stub).
- **FE**: agregar un select de proyecto en `DatosForm` populado por `useProjects()`, marcado **required** a nivel UI.
- **FE**: cuando el proyecto cambia y `task.iclassOrderCode != null`, mostrar warning inline: "Esta tarea ya tiene OS en IClass. El cambio no afecta la OS creada."

### Out of Scope
- **Bulk reassign** de proyecto sobre múltiples tareas — UX y endpoint separados, propuesta aparte.
- **Migración de tareas legacy** sin `projectId` poblado — se mantienen como están; el operador las "regulariza" al editarlas.
- **Cambio de schema** de `projectId` a `NOT NULL` — queda como follow-up; por ahora la columna sigue nullable.
- **Cambios en `CreateTaskModal`** más allá de asegurar que el select existente sigue funcionando (no se rediseña ese modal).

## Capabilities

### New Capabilities
- None

### Modified Capabilities
- `scheduling`: `CreateTask` y `UpdateTask` SHALL validar `projectId` contra un `EntityLookup<Project>` cuando el campo esté presente y no sea `null`. Project inexistente SHALL responder HTTP 404 con `{ code: "PROJECT_NOT_FOUND" }`. Continúa numeración de REQs en la sección 4 (Create) y 5 (Update).

## High-Level Approach

### Backend
1. `src/domain/errors/scheduling.ts`: `ReferenceKind` pasa a `'customer' | 'service' | 'partner' | 'reporter' | 'assignee' | 'watcher' | 'project'`.
2. `src/infrastructure/http/routes/scheduling.routes.ts`: `REFERENCE_TO_CODE` agrega `project: 'PROJECT_NOT_FOUND'`.
3. `src/application/use-cases/CreateTask.ts` y `UpdateTask.ts`: aceptan un `projectLookup: EntityLookup` adicional en el constructor. Validan en el orden canónico `customer → service → partner → project → reporter → assignee → watchers` con la misma forma (`if (data.projectId !== undefined && data.projectId !== null) { ... }`).
4. `src/infrastructure/http/app.ts` (~línea 464): wirea un `PrismaProjectLookup` (o reusa el adapter existente si ya hay uno para `iclass-so-type-mapping`) y lo inyecta en ambos use cases.
5. Tests existentes de `CreateTask` / `UpdateTask` / route-tests deben recibir un `StubLookup` para project con los IDs usados en los fixtures.

### Frontend
1. `DatosForm`: renderear un `<Select>` para proyecto, populado por `useProjects()`, con `required` HTML + validación del form. El valor inicial se toma de `task.projectId`.
2. Cuando el usuario cambia el valor y `task.iclassOrderCode != null`, mostrar un banner/inline-warning debajo del select con el copy acordado.
3. `DatosFormValues.projectId` ya existe; el cambio entra como parte del payload existente del save unificado (`updateTask`) — no requiere endpoint nuevo.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/domain/errors/scheduling.ts` | Modified | `ReferenceKind` agrega `'project'` |
| `src/infrastructure/http/routes/scheduling.routes.ts` | Modified | `REFERENCE_TO_CODE.project = 'PROJECT_NOT_FOUND'` |
| `src/application/use-cases/CreateTask.ts` | Modified | Recibe `projectLookup`, valida `projectId` |
| `src/application/use-cases/UpdateTask.ts` | Modified | Recibe `projectLookup`, valida `projectId` |
| `src/infrastructure/http/app.ts` | Modified | Wiring del project lookup |
| `src/__tests__/application/CreateTask.test.ts` | Modified | Inyecta stub project lookup; nuevo caso PROJECT_NOT_FOUND |
| `src/__tests__/application/UpdateTask.test.ts` | Modified | Idem |
| `src/__tests__/infrastructure/scheduling.routes.test.ts` | Modified | `StubLookup` project con los IDs de fixture |
| `ipnext-frontend/.../DatosForm.*` | Modified | Select de project + warning |
| `ipnext-frontend/.../DatosForm.test.*` | Modified | Cobertura del select y del warning |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Tests existentes de Create/Update se rompen porque el constructor ahora pide un lookup más | High | Cambio mecánico: actualizar todos los call-sites en el test harness en el mismo commit. Stubs in-memory ya están en uso para los otros lookups. |
| Fixtures de route-tests no seedean projects; los IDs usados hoy van a fallar la validación | High | Agregar al `StubLookup` de project los IDs que aparecen en los fixtures de tarea; alternativa: omitir `projectId` en los fixtures que no lo necesitan. |
| Tareas legacy en prod tienen `projectId: null`. La UI required obliga a elegir uno antes de poder guardar cualquier otro cambio del detalle | Med | Es la UX elegida (regularización oportunista). Documentar en release notes; ningún backfill. |
| El "required" es **client-side only** — el schema sigue nullable y un PATCH directo puede mandar `projectId: null` | Low | Aceptado por ahora. El follow-up de schema NOT NULL lo cierra a nivel BE. |
| `PrismaProjectLookup` puede ya existir o no según trabajo previo de `iclass-so-type-mapping` | Low | Verificar en `infrastructure/adapters/prisma/` durante design; si existe, reusar; si no, crearlo siguiendo el patrón de `PrismaCustomerLookup`. |

## Frontend Implications (touch points only, NO design)

- `DatosForm`: nuevo campo controlado para project. Required al submit.
- `DatosForm`: estado derivado `showIClassWarning = task.iclassOrderCode != null && projectId !== task.projectId`.
- `useProjects()`: ya existe, se consume tal cual. Si está loading, el select queda disabled.
- Submit path: `projectId` viaja en el payload existente de `updateTask` — sin nuevas llamadas API.
- Tests FE: verificar render del select, required-validation y aparición condicional del warning.

## Rollback Plan

Revertir BE y FE por separado (commits independientes). El BE no toca schema ni migra datos; el FE no rompe rutas viejas. `git revert <sha>` por repo y deploy automático restaura.

## Dependencies

- Ninguna externa. Depende de que el patrón `EntityLookup<Project>` se pueda materializar (Prisma adapter existente o nuevo trivial).

## Success Criteria

- [ ] `PUT /api/scheduling/:id` con `projectId` inválido responde 404 con `{ code: "PROJECT_NOT_FOUND" }` (no 500).
- [ ] `POST /api/scheduling` idem.
- [ ] El detalle de tarea en FE muestra select de proyecto editable.
- [ ] Guardar el detalle con el select vacío es bloqueado por validación cliente.
- [ ] Cambiar el proyecto en una tarea con `iclassOrderCode` muestra el warning.
- [ ] `npm test` (BE) y `npx vitest run` (FE) verdes.
- [ ] No regresiones en el flow de creación (modal existente sigue funcionando).
