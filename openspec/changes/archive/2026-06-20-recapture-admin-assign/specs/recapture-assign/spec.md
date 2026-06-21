# recapture-assign Specification (delta)

Delta sobre el módulo de recaptación (`#80`). Define el modelo "admin asigna" con el permiso granular `recapture.assign`, la restricción server-side por actor, el bulk-assign y la eliminación de self-take.

## ADDED Requirements

### Requirement: Permiso RBAC `recapture.assign`

El sistema MUST definir el action code `assign` en `KNOWN_ACTIONS` y MUST persistir el permiso `(recapture, assign)` en la DB mediante una migración de datos idempotente, otorgándolo a los roles `super_admin` y `administrador`. La migración MUST poder correrse dos veces sin error ni filas duplicadas (`ON CONFLICT DO NOTHING`).

#### Scenario: assign está en el whitelist de acciones

- GIVEN el archivo `src/domain/entities/rbac.ts`
- WHEN se inspecciona `KNOWN_ACTIONS`
- THEN incluye el valor `'assign'`
- AND `PermissionAction` admite `'assign'`

#### Scenario: super_admin y administrador reciben recapture.assign

- GIVEN la migración `20260804000000_recapture_assign_permission` aplicada
- WHEN se consultan los grants de `RbacRolePermission` para el permiso `(recapture, assign)`
- THEN existe un grant para el rol `super_admin`
- AND existe un grant para el rol `administrador`

#### Scenario: la migración es idempotente

- GIVEN la migración ya aplicada
- WHEN se corre una segunda vez
- THEN no produce error
- AND el conteo de filas de `RbacPermission` y `RbacRolePermission` para recapture.assign queda sin cambios

### Requirement: Bulk assign de leads

El sistema MUST exponer `PATCH /api/recapture/leads/assign-bulk` con body `{ leadIds: string[], operatorId: string | null }`, gateado por el permiso `recapture.assign`. Si `operatorId` no es null, el sistema MUST validar que el usuario existe antes de asignar. La respuesta MUST informar cuántos leads se asignaron efectivamente. Los `leadIds` inexistentes MUST ignorarse y NO contarse.

#### Scenario: admin asigna varios leads a un operador

- GIVEN un actor con permiso `recapture.assign`
- AND existen los leads `l1`, `l2`, `l3` y el operador `op-1`
- WHEN hace `PATCH /api/recapture/leads/assign-bulk` con `{ leadIds: ["l1","l2","l3"], operatorId: "op-1" }`
- THEN la respuesta es `200` con `{ assigned: 3 }`
- AND los tres leads quedan con `assigneeId = "op-1"` y `status = "en_gestion"`

#### Scenario: operatorId inexistente rechaza el bulk

- GIVEN un actor con permiso `recapture.assign`
- AND el operador `ghost` no existe
- WHEN hace `PATCH /api/recapture/leads/assign-bulk` con `{ leadIds: ["l1"], operatorId: "ghost" }`
- THEN la respuesta es `400` con code `REFERENCE_NOT_FOUND`
- AND ningún lead cambia de asignación

#### Scenario: bulk con leadIds parcialmente inexistentes solo cuenta los existentes

- GIVEN un actor con permiso `recapture.assign`
- AND existe el lead `l1` pero no `nope`
- WHEN hace `PATCH /api/recapture/leads/assign-bulk` con `{ leadIds: ["l1","nope"], operatorId: "op-1" }`
- THEN la respuesta es `200` con `{ assigned: 1 }`

#### Scenario: bulk-assign requiere permiso assign

- GIVEN un actor SIN permiso `recapture.assign`
- WHEN hace `PATCH /api/recapture/leads/assign-bulk` con un body válido
- THEN la respuesta es `403` con code `PERMISSION_DENIED`

#### Scenario: bulk-assign valida el body

- GIVEN un actor con permiso `recapture.assign`
- WHEN hace `PATCH /api/recapture/leads/assign-bulk` con `leadIds` ausente o vacío
- THEN la respuesta es `400` con code `VALIDATION_ERROR`

### Requirement: Restricción server-side por actor en lectura de leads

En `GET /api/recapture/leads`, si el actor NO tiene el permiso `recapture.assign`, el sistema MUST forzar el filtro a sus propios leads (`assigneeId = actorId`) e ignorar cualquier filtro de query que exponga leads de otros. Si el actor tiene `recapture.assign`, el sistema MUST respetar los filtros provistos (ve todos).

#### Scenario: agente ve solo sus leads asignados

- GIVEN un actor `agente-1` SIN permiso `recapture.assign`
- AND existen leads asignados a `agente-1` y leads asignados a `otro`
- WHEN hace `GET /api/recapture/leads`
- THEN la respuesta `200` solo contiene leads con `assigneeId = "agente-1"`

#### Scenario: agente no puede ver leads de otros vía filtro de query

- GIVEN un actor `agente-1` SIN permiso `recapture.assign`
- WHEN hace `GET /api/recapture/leads?assigneeId=otro`
- THEN la respuesta `200` solo contiene leads de `agente-1` (el filtro `assigneeId=otro` se ignora)

#### Scenario: admin ve todos los leads

- GIVEN un actor con permiso `recapture.assign`
- WHEN hace `GET /api/recapture/leads`
- THEN la respuesta `200` contiene leads de todos los asignados

### Requirement: Restricción server-side por actor en detalle y gestión de un lead

En `GET /api/recapture/leads/:id`, `PATCH /api/recapture/leads/:id` y `POST /api/recapture/leads/:id/contacts`, si el actor NO tiene `recapture.assign`, el sistema MUST verificar que `lead.assigneeId === actorId`; si no coincide (o el lead no existe), MUST responder `404` con code `RECAPTURE_LEAD_NOT_FOUND` sin revelar la existencia del lead ajeno. Si el actor tiene `recapture.assign`, MUST operar sin restricción de pertenencia.

#### Scenario: agente lee su propio lead

- GIVEN un actor `agente-1` SIN `recapture.assign`
- AND el lead `l1` tiene `assigneeId = "agente-1"`
- WHEN hace `GET /api/recapture/leads/l1`
- THEN la respuesta es `200` con el detalle de `l1`

#### Scenario: agente no puede leer un lead ajeno

- GIVEN un actor `agente-1` SIN `recapture.assign`
- AND el lead `l2` tiene `assigneeId = "otro"`
- WHEN hace `GET /api/recapture/leads/l2`
- THEN la respuesta es `404` con code `RECAPTURE_LEAD_NOT_FOUND`

#### Scenario: agente no puede cambiar el estado de un lead ajeno

- GIVEN un actor `agente-1` SIN `recapture.assign`
- AND el lead `l2` tiene `assigneeId = "otro"`
- WHEN hace `PATCH /api/recapture/leads/l2` con `{ status: "contactado" }`
- THEN la respuesta es `404` con code `RECAPTURE_LEAD_NOT_FOUND`
- AND el lead `l2` no cambia de estado

#### Scenario: agente no puede registrar contacto en un lead ajeno

- GIVEN un actor `agente-1` SIN `recapture.assign`
- AND el lead `l2` tiene `assigneeId = "otro"`
- WHEN hace `POST /api/recapture/leads/l2/contacts` con un body válido
- THEN la respuesta es `404` con code `RECAPTURE_LEAD_NOT_FOUND`

#### Scenario: agente gestiona su propio lead

- GIVEN un actor `agente-1` SIN `recapture.assign`
- AND el lead `l1` tiene `assigneeId = "agente-1"`
- WHEN hace `PATCH /api/recapture/leads/l1` con `{ status: "contactado" }`
- THEN la respuesta es `200`
- AND el lead `l1` queda en `status = "contactado"`

## MODIFIED Requirements

### Requirement: Asignación individual de lead requiere permiso assign

El endpoint `PATCH /api/recapture/leads/:id/assign` MUST estar gateado por el permiso `recapture.assign` (antes: `recapture.manage`). Mantiene el body `{ operatorId: string | null }`, la validación de existencia del operador y la semántica de asignar/reasignar/desasignar.

#### Scenario: agente no puede asignar un lead

- GIVEN un actor SIN permiso `recapture.assign`
- WHEN hace `PATCH /api/recapture/leads/l1/assign` con `{ operatorId: "op-1" }`
- THEN la respuesta es `403` con code `PERMISSION_DENIED`

#### Scenario: admin asigna un lead individual

- GIVEN un actor con permiso `recapture.assign`
- AND existen el lead `l1` y el operador `op-1`
- WHEN hace `PATCH /api/recapture/leads/l1/assign` con `{ operatorId: "op-1" }`
- THEN la respuesta es `200` con `assigneeId = "op-1"` y `status = "en_gestion"`

### Requirement: Ingesta de bajas e importación CSV requieren permiso assign

Los endpoints `POST /api/recapture/ingest-churned` y `POST /api/recapture/import-csv` MUST estar gateados por `recapture.assign` (antes: `recapture.manage`), por ser operaciones de administración del pool de leads.

#### Scenario: agente no puede ingestar bajas

- GIVEN un actor SIN permiso `recapture.assign`
- WHEN hace `POST /api/recapture/ingest-churned`
- THEN la respuesta es `403` con code `PERMISSION_DENIED`

#### Scenario: agente no puede importar CSV

- GIVEN un actor SIN permiso `recapture.assign`
- WHEN hace `POST /api/recapture/import-csv` con `{ csv: "..." }`
- THEN la respuesta es `403` con code `PERMISSION_DENIED`

#### Scenario: admin ingesta bajas

- GIVEN un actor con permiso `recapture.assign`
- WHEN hace `POST /api/recapture/ingest-churned`
- THEN la respuesta es `200` con el conteo de leads creados

## REMOVED Requirements

### Requirement: Self-take de leads (claim / claim-next)

Se eliminan los endpoints `POST /api/recapture/leads/claim-next` y `POST /api/recapture/leads/:id/claim` y los use cases `ClaimNextRecaptureLead` y `ClaimRecaptureLead`. Ningún agente puede auto-tomarse leads; la asignación la realiza exclusivamente el admin.

#### Scenario: claim-next ya no existe

- GIVEN cualquier actor autenticado
- WHEN hace `POST /api/recapture/leads/claim-next`
- THEN la respuesta es `404` (ruta inexistente)

#### Scenario: claim individual ya no existe

- GIVEN cualquier actor autenticado
- WHEN hace `POST /api/recapture/leads/l1/claim`
- THEN la respuesta es `404` (ruta inexistente)

### Requirement: Release de lead

Se elimina el endpoint `POST /api/recapture/leads/:id/release` y el use case `ReleaseRecaptureLead`. El desasignar un lead se realiza vía `PATCH /api/recapture/leads/:id/assign { operatorId: null }`, gateado por `recapture.assign` (operación de admin).

#### Scenario: release ya no existe

- GIVEN cualquier actor autenticado
- WHEN hace `POST /api/recapture/leads/l1/release`
- THEN la respuesta es `404` (ruta inexistente)
