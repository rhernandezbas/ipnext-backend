# Exploration: task-manual-retiro (Backlog #39)

## Current State

### Project model (schema)
`Project` en `prisma/schema.prisma` (líneas 1065-1096) tiene los campos:
- `id`, `title`, `description`, `typeId`, `categoryId`, `workflowId`, `projectLeadId`, `visible`
- `iclassSoTypeId` (FK a IClassSoType — el mapeo IClass ya usa este patrón)
- **NO tiene ningún campo de retiro**. La migración aditiva agregaría `allowsEquipmentRetirement Boolean @default(false)`.

La entidad de dominio `src/domain/entities/project.ts` solo expone los campos arriba más `iclassSoType` resuelto.

El `ProjectRepository` (port) en `src/domain/ports/ProjectRepository.ts` expone:
```ts
list, get, create, update(id, UpdateProjectInput), delete, updateIClassSoType
```
Se necesita análogo `updateEquipmentRetirement(projectId, value: boolean)` o bien ampliar `UpdateProjectInput` para incluir `allowsEquipmentRetirement`.

### ScheduledTask — DTO y relación con Project
- `ScheduledTask` entity (`src/domain/entities/scheduling.ts`) ya tiene `projectId?: string | null` y `projectName?: string | null` (línea 20).
- El DTO del FE (`src/types/scheduling.ts`) incluye `projectId: string | null` y `projectName: string | null`.
- El task detail page (`SchedulingTaskDetailPage.tsx`) ya pasa `task.projectId` al `DatosForm`.
- **El task ya conoce su projectId**. El FE puede derivar si el proyecto es "de retiro" en dos caminos: (a) consultar `GET /projects/:id` y verificar `allowsEquipmentRetirement`, o (b) que el task DTO incluya el flag computado `projectAllowsRetirement: boolean`.

### Punto de anclaje FE para el picker
El panel de inventario de la tarea vive en `TaskTabs.tsx` → componente `InventoryPanel` (inline, líneas 93-178). Este panel ya muestra:
- Pills de estado de retorno (W4 IClass)
- `TaskInventorySuggestions` (checklist OCR)
- `TaskMaterialConsumptions`

El sidebar derecho (`CustomerSidebar.tsx`) contiene la tab "Inventario" con `ContractInventoryReadonly` — lista los equipos ACTIVOS del contrato (usa `GET /contracts/:contractId/inventory` vía `useServiceInstalledItems`). **Este es el inventario real del contrato** y es exactamente la fuente de datos para el picker de retiro.

**Decisión de anclaje**: el botón "Retirar" debe vivir en `InventoryPanel` (tab Inventory de la tarea), NO en el sidebar. Razones:
1. El sidebar es read-only por diseño (ContractInventoryReadonly).
2. La acción "Retirar" está asociada a la tarea (el retiro se registra con `taskId`).
3. El picker puede reusar el mismo fetch de `ContractInventoryReadonly` (misma query key).
4. El sidebar "Inventario del cliente" puede quedar como está — solo muestra el estado real post-retiro.

### RemoveInstalledItem (#8, use case existente)
`src/application/use-cases/RemoveInstalledItem.ts`: soft-delete CII (`status → 'removed'`). **NO toca el asset ni el ledger**. Es el gap que el spec menciona — hoy un retiro manual en la UI ya existe en las routes (`DELETE /contracts/:contractId/inventory/:itemId`) pero solo mueve el CII a `removed`, sin asset.

### ConfirmAssetReturn (W4 — el patrón a espejar)
`src/application/use-cases/ConfirmAssetReturn.ts`: el caso de uso de referencia. Demuestra el patrón completo:
- Verifica `asset.status === 'installed'` (guard)
- L2 idempotency via `sourceRef`
- `UnitOfWork.runInTransaction` → `movements.record(RETURN)` + flip asset `available@depot` (todo atómico)
- `resolveDepot.execute('DEPOSITO')` para el singleton del depósito

### UnitOfWork slots actuales
`src/domain/ports/UnitOfWork.ts` — `TransactionalRepos` incluye: `suggestions`, `inventory`, `locations`, `assets`, `movements`, `returns?`, `deductions?`, `consumptions?`, `stock?`. El nuevo use case necesitará acceso a `inventory` (CII) + `assets` + `movements` dentro del UoW — **ya están en el bag**. Solo hay que agregar el slot `cii?` si necesitamos tx-scoped ContractInventoryRepository separado (actualmente el bag ya tiene `inventory` que ES el ContractInventoryRepository — nombre confuso pero está).

### ResolveDepotLocation
`src/application/use-cases/ResolveDepotLocation.ts`: find-or-create idempotente del singleton DEPOSITO. Ya disponible para inyección en el nuevo use case.

### Permisos existentes (RBAC)
Módulos relevantes en `src/domain/entities/rbac.ts`:
- `inventory` (con acciones `read`, `write`, `manage`) — ya usado por todos los endpoints de inventario
- `scheduling` (con acciones `read`, `write`, `manage`, `send_to_iclass`, etc.)

**Recomendación de permisos**:
- Botón/endpoint de retiro → `inventory.write` (consistente con `ConfirmAssetReturn`, `ConfirmInventorySuggestion`, todos los mutations de inventario)
- Mapeo de proyectos de retiro (config) → `inventory.manage` (NO `scheduling.manage`)
  - Evidencia: el patrón IClass usa `iclass.assign_to_project` (sub-acción del módulo iclass). El mapeo de proyectos de retiro es config de inventario, no de scheduling. `inventory.manage` ya existe y se usa para `CorrectConfirmedDeviceType`. Coherente.

### Config page — dónde vive el mapeo de proyectos
- `InventorySettingsPage.tsx` ya tiene tabs: Equipos / Materiales / Camionetas / Automatizaciones.
- El patrón exacto a seguir es `IClassProjectMappingBody.tsx` en `src/pages/scheduling/settings/` — tabla de proyectos con toggle/checkbox por fila, auto-save inline, gateado con `inventory.manage`.
- **Recomendación**: agregar tab "Proyectos de retiro" en `InventorySettingsPage` (no en Scheduling Settings). Justificación: la funcionalidad es de inventario (controla el flujo de retiro de equipos), no de scheduling.

### Rutas BE existentes de proyectos
`src/infrastructure/http/routes/projects.routes.ts`: GET, POST, PUT/PATCH `/:id`, DELETE. El PATCH ya maneja `iclassSoTypeId` inline + delega a `AssignIClassSoTypeToProject`. Se puede usar el mismo patrón: PATCH `/:id` con `allowsEquipmentRetirement: boolean` en el body → `UpdateProjectInput` ampliado.

### Adapter Prisma de Project
`src/infrastructure/adapters/prisma/PrismaProjectRepository.ts` — tendrá que hacer select del nuevo campo. Las migraciones van via `prisma migrate dev`.

## Affected Areas

### BE — archivos a crear
- `prisma/migrations/YYYYMMDDHHMMSS_project_allows_equipment_retirement/` — ADD COLUMN aditivo
- `src/application/use-cases/RetireContractEquipment.ts` — use case principal
- `src/application/use-cases/GetContractEquipmentForRetirement.ts` — query: equipos activos del contrato de la tarea (puede ser un nuevo use case o bien se reusan `ListContractInstalledItems` + filtro `status=active`)
- `src/domain/errors/inventory.ts` — nuevos errores: `ProjectNotRetirementError`, `EquipmentAlreadyRemovedError` (o reusar `AssetNotReturnableError`)

### BE — archivos a modificar
- `prisma/schema.prisma` — agregar `allowsEquipmentRetirement Boolean @default(false)` en `Project`
- `src/domain/entities/project.ts` — agregar campo
- `src/domain/ports/ProjectRepository.ts` — ampliar `UpdateProjectInput` + opcionalmente `updateEquipmentRetirement`
- `src/infrastructure/adapters/prisma/PrismaProjectRepository.ts` — select del nuevo campo
- `src/infrastructure/http/routes/projects.routes.ts` — exponer el campo en PATCH (o no: se puede hacer directo via UpdateProject si se amplía)
- `src/infrastructure/http/routes/scheduling.routes.ts` — agregar endpoint `POST /scheduling/:taskId/retire-equipment`
- `src/infrastructure/http/app.ts` — wire up del nuevo use case

### FE — archivos a crear
- `src/pages/inventory/settings/RetirementProjectsBody.tsx` — tab config análoga a IClassProjectMappingBody

### FE — archivos a modificar
- `src/pages/inventory/InventorySettingsPage.tsx` — agregar tab "Proyectos de retiro"
- `src/pages/scheduling/SchedulingTaskDetailPage/components/TaskTabs.tsx` → `InventoryPanel` — agregar botón/picker "Retirar"
- `src/types/scheduling.ts` — opcionalmente agregar `projectAllowsRetirement?: boolean` al ScheduledTask DTO (si se prefiere flag computado en el task DTO vs fetch separado del proyecto)
- `src/types/projects.ts` (o equivalente) — agregar `allowsEquipmentRetirement: boolean` a `Project`
- `src/api/projects.ts` (o hooks) — incluir el nuevo campo

## Decision Points for Proposal

### D1: `allowsEquipmentRetirement` boolean en Project vs tabla aparte
**Recomendación: boolean en Project.**
- Un proyecto ES o NO de retiro — no hay semántica adicional (no hay prioridad, fecha de vigencia, etc.).
- Exactamente igual a `visible: boolean` en Project.
- Migración aditiva trivial: `ADD COLUMN "allowsEquipmentRetirement" BOOLEAN NOT NULL DEFAULT false` — no rompe nada, todos los proyectos arrancan en `false`.
- Una tabla aparte solo agregaría complejidad sin beneficio. Tabla separada tiene sentido cuando el mapeo es N:M o lleva metadatos (ej. ProjectPartner). Aquí es 1:1 y binario.

### D2: Cómo el FE sabe si la tarea está en proyecto de retiro
**Recomendación: incluir `projectAllowsRetirement: boolean` en el task DTO.**
- Evita un segundo fetch `GET /projects/:id` en el task detail (que ya es un fetch pesado).
- El BE ya hace el JOIN de project cuando devuelve la tarea (projectId + projectName están en el DTO).
- Bajo costo: una columna booleana que el Prisma ya trae del JOIN.
- Alternativa (fetch separado): más redondeos de red, más carga en el detalle. Descartada.
- El BE también valida server-side (el botón oculto no es seguridad), pero el flag en el DTO permite mostrar/ocultar el botón sin RTT adicional.

### D3: Dónde vive el picker de retiro en el FE
**Recomendación: dentro de `InventoryPanel` en la tab Inventory de la tarea.**
- El sidebar es readonly y debe mantenerse así.
- La acción se registra con taskId — semánticamente pertenece a la tarea.
- Los datos (equipos activos del contrato) se obtienen del mismo endpoint que ya usa `ContractInventoryReadonly` — se puede compartir cache React Query.
- UX: el operador está en la tarea → tab Inventory → ve los equipos → click "Retirar" → picker → confirm-dialog → aplicación directa.

### D4: Gating server-side del retiro por proyecto
El endpoint `POST /scheduling/:taskId/retire-equipment` DEBE:
1. Cargar la tarea para obtener `projectId`.
2. Cargar el proyecto para verificar `allowsEquipmentRetirement === true`.
3. Si false → 403/422 con código `PROJECT_NOT_RETIREMENT` (el botón oculto NO es suficiente seguridad).
El campo `contractId` también se valida: si la tarea no tiene contrato → 422 `TASK_HAS_NO_CONTRACT`.

### D5: Permiso del mapeo de proyectos de retiro
**Recomendación: `inventory.manage`** (no `scheduling.manage`).
- La config controla el flujo de retiro de equipos → módulo `inventory`.
- `inventory.manage` ya se usa para `CorrectConfirmedDeviceType` (admin-only correction).
- `scheduling.manage` es para acciones de scheduling (bulk operations sobre tareas, etc.) — sería incoherente.

### D6: Shape del use case `RetireContractEquipment`
```ts
// Input
interface RetireContractEquipmentInput {
  taskId: string;
  itemIds: string[];  // uno o más CII activos del contrato (retiro parcial es norma)
  actorId: string | null;
}

// Guards (en orden, TODOS server-side):
// 1. Task existe → TaskNotFoundError
// 2. Task tiene contractId → TaskHasNoContractError
// 3. Task tiene projectId + proyecto.allowsEquipmentRetirement === true → ProjectNotRetirementError
// 4. Para cada itemId:
//    a. CII existe + status === 'active' → EquipmentAlreadyRemovedError (no lanzar, skip graceful)
//    b. CII pertenece al contractId de la tarea → EquipmentNotOnContractError (403)
//    c. asset vinculado (cii.assetId) existe + status !== 'available'@depot → si ya en depot, skip idempotente
// 5. Atomicidad (UoW por ítem o batch): para cada ítem válido:
//    - CII → status = 'removed'
//    - asset → RETURN movement a DEPOSITO (source='MANUAL', taskId)
//    - asset → status = 'available', currentLocationId = depotId
// 6. Retorno: lista de CIIs procesados (con su nuevo status)

// sourceRef pattern para idempotencia: 'manual:retire:{taskId}:{ciiId}'
```

### D7: Sin `confirmedMovementId` en CII ni en ReturnSuggestion
No se crea `ReturnSuggestion`. La acción es directa (no staging). El vínculo de trazabilidad es el `InventoryMovement.taskId` (ya existe en el modelo) y `source='MANUAL'`.

### D8: Tareas sin contrato
Si `task.contractId === null` → el endpoint retorna 422 `TASK_HAS_NO_CONTRACT`. En el FE: si no hay contractId, el botón "Retirar" no se muestra (o aparece disabled con tooltip). Caso sin equipos activos: el picker aparece vacío → mensaje amigable "Sin equipos activos en este contrato" y el botón de confirmar deshabilitado. No es error.

## Approaches

### Approach A: Nuevo endpoint en scheduling routes + UoW atómico (RECOMENDADO)
**Endpoint**: `POST /scheduling/:taskId/retire-equipment` (mounted en `scheduling.routes.ts`)
- Justificación: está anclado a la tarea (taskId en el path), consistente con otros endpoints task-scoped como `/scheduling/:taskId/inventory/suggestions`.
- Use case `RetireContractEquipment` opera sobre múltiples CIIs en un loop con `UoW.runInTransaction` por ítem (o un único batch tx si se extiende el UoW con soporte batch — ver abajo).
- Guards: task → project.allowsEquipmentRetirement → CII activo + del contrato → asset no en depot ya.
- Pros: limpio, sin staging, directo, trazable via movement.taskId.
- Cons: UoW actual no tiene batch nativo — se pueden hacer N transacciones (una por ítem) o extender el UoW.
- Effort: Medium.

### Approach B: Endpoint en inventory routes
**Endpoint**: `POST /inventory/tasks/:taskId/retire`
- Pros: cohesión conceptual con el módulo inventory.
- Cons: rompe el patrón de task-scoped routes (todo lo de `/scheduling/:taskId/...` está en scheduling.routes). Mayor divergencia del estilo existente.
- Effort: Medium. Descartado.

### Approach C: Reusar RemoveInstalledItem + RETURN movement por separado (dos pasos)
- No atómico: si el RETURN falla después del CII remove, el estado es inconsistente.
- Descartado. La atomicidad es un requisito hard.

## Recommendation
**Approach A** con las decisiones D1-D8.

Un solo endpoint task-scoped `POST /scheduling/:taskId/retire-equipment`, use case `RetireContractEquipment` que hace CII removed + RETURN movement + asset available@depot en una tx (UoW). Config tab "Proyectos de retiro" en InventorySettings (no Scheduling). Picker dentro de `InventoryPanel` en la tab Inventory de la tarea. Flag `projectAllowsRetirement` en el task DTO para gate sin RTT extra.

## Risks

### R1: Migración en Project — tabla viva con FKs
`Project` es una tabla activa con FKs desde `ScheduledTask` (ON DELETE: implícito SetNull o Restrict según schema). El `ADD COLUMN ... DEFAULT false` en Postgres es instantáneo para tablas con muchas filas (operación de metadata, no rewrite). Sin embargo, en prod hay que verificar: si la tabla tiene constraints CHECK o índices sobre columnas boolean, agregar un índice parcial en la nueva columna podría ser necesario para el tab de config (filtrar proyectos de retiro).

### R2: Atomicidad CII + asset + movement — batch vs loop de tx
El UoW actual (`UnitOfWork.runInTransaction`) está diseñado para una sola transacción. Si se retiran N ítems, la opción más segura es **un único `runInTransaction` que haga N writes dentro** (todo-or-nothing: si falla el ítem 3 de 5, todo hace rollback). Esto requiere que el UoW pase el bag a la función que itera, NO N llamadas separadas a `runInTransaction`. El in-memory adapter (tests) ya soporta el patrón de función con múltiples writes.

### R3: Tareas sin contrato — query de equipos
Si `task.contractId === null`, el endpoint no puede listar equipos. La query de equipos activos del contrato (`GET /contracts/:contractId/inventory`) ya existe; basta filtrar `status === 'active'`. En el FE, `useServiceInstalledItems(contractId)` ya está disponible en `ContractInventoryReadonly` — se puede reusar.

### R4: CIIs sin assetId (legacy)
`ContractInstalledItem.assetId` es nullable (filas legacy previas a W1). Si `cii.assetId === null`, el RETURN no tiene asset que mover. Opciones:
- (a) Solo retirar CIIs con `assetId != null` (los sin asset no tienen stock que devolver — skip con advertencia).
- (b) Retirar siempre el CII (soft-delete) independientemente del asset, y solo hacer el RETURN movement si `assetId` existe.
  **Recomendación: opción (b)** — el CII siempre se marca como removed (historial semántico); el movement de depósito solo ocurre si hay asset vinculado. Esto es coherente con el patrón de `ConfirmAssetReturn(create)` donde el asset puede no existir aún.

### R5: Asset ya en depot (retiro doble)
Si `asset.status === 'available'` y `currentLocation === DEPOSITO`, el asset ya está en depot. Guard: detectar `asset.status !== 'installed'` antes del RETURN y hacer skip idempotente (no error, no movement). El CII de todos modos se marca `removed`. Documentar como retiro graceful.

### R6: `projectAllowsRetirement` en el task DTO — JOIN Prisma
El `PrismaSchedulingRepository.getTask` ya hace joins (projectName). Agregar `project.allowsEquipmentRetirement` al select es trivial pero requiere actualizar el mapper. Hay que asegurarse de que todos los tests in-memory también propaguen el campo (valor booleano, default false).

## File Map

### BE
```
prisma/schema.prisma                                    (modificar — Project model)
prisma/migrations/YYYYMMDDHHMMSS_project_retirement/    (crear)
src/domain/entities/project.ts                          (modificar — agregar campo)
src/domain/ports/ProjectRepository.ts                   (modificar — UpdateProjectInput)
src/domain/errors/inventory.ts                          (modificar — nuevos errores)
src/application/use-cases/RetireContractEquipment.ts    (crear)
src/infrastructure/adapters/prisma/PrismaProjectRepository.ts    (modificar — select)
src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts (modificar — JOIN + mapper)
src/infrastructure/adapters/in-memory/InMemoryProjectRepository.ts (modificar — campo)
src/infrastructure/http/routes/scheduling.routes.ts     (modificar — endpoint retire)
src/infrastructure/http/app.ts                          (modificar — wiring)
src/__tests__/application/RetireContractEquipment.test.ts (crear)
```

### FE
```
src/types/scheduling.ts                                 (modificar — projectAllowsRetirement)
src/types/projects.ts (o equivalente)                   (modificar — allowsEquipmentRetirement)
src/pages/inventory/InventorySettingsPage.tsx            (modificar — agregar tab)
src/pages/inventory/settings/RetirementProjectsBody.tsx (crear — análoga a IClassProjectMappingBody)
src/pages/scheduling/SchedulingTaskDetailPage/components/TaskTabs.tsx (modificar — picker en InventoryPanel)
src/api/scheduling.ts (o hooks)                         (modificar — retireEquipment mutation)
```

## Ready for Proposal
Yes. Las decisiones están claras:
- Schema: `allowsEquipmentRetirement boolean @default(false)` en Project (migración aditiva).
- Config: tab en InventorySettings (no Scheduling), gateado con `inventory.manage`.
- Picker: en InventoryPanel (tab Inventory de la tarea).
- Use case: `RetireContractEquipment` — CII removed + RETURN movement + asset available@depot, atómico vía UoW, todo en una tx.
- Gating FE: flag `projectAllowsRetirement` en el task DTO (sin RTT extra).
- Gating BE: server-side validation del proyecto + contrato en el endpoint.
- Permisos: `inventory.write` para el retiro; `inventory.manage` para la config.
- CIIs sin assetId: CII siempre removed, RETURN solo si assetId existe.
- Sin staging: aplicación directa con confirm-dialog en el FE.
- `source='MANUAL'` en el movement, `taskId` para trazabilidad.
