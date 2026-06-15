# Spec — IClass Ops Config

> Capability: `iclass-ops-config` (delta). Configurar la operación de IClass desde Prominense: mapear técnicos a cuadrillas con auto-asignación best-effort, togglear los feature flags de acciones, y dar visibilidad de lo que se despacha.

## ADDED Requirements

### Requirement: Mapear técnico a cuadrilla de IClass

El sistema DEBE permitir asociar cada técnico (`RbacUser`) a una cuadrilla del catálogo `IClassTeam`, persistiendo el `login` de la cuadrilla como soft FK en `RbacUser.iclassTeamLogin`, validando que la cuadrilla sea asignable al momento de mapear.

#### Scenario: Mapeo exitoso a cuadrilla asignable
- **GIVEN** un técnico `RbacUser` existente
- **AND** una cuadrilla del catálogo con `active === true` y `selectable === true`
- **WHEN** un usuario con permiso `iclass.manage` mapea el técnico a esa cuadrilla
- **THEN** el sistema persiste `iclassTeamLogin = team.login` en el `RbacUser`
- **AND** responde 200 con `{ userId, iclassTeamLogin, teamName, teamActive: true }`

#### Scenario: Mapeo a cuadrilla inactiva rechazado
- **GIVEN** una cuadrilla con `active === false`
- **WHEN** se intenta mapear un técnico a esa cuadrilla
- **THEN** el sistema responde 422 `ICLASS_TEAM_NOT_ASSIGNABLE`
- **AND** NO modifica el `iclassTeamLogin` del técnico

#### Scenario: Mapeo a cuadrilla agrupadora (no-selectable) rechazado
- **GIVEN** una cuadrilla con `selectable === false` (grouper organizacional)
- **WHEN** se intenta mapear un técnico a esa cuadrilla
- **THEN** el sistema responde 422 `ICLASS_TEAM_NOT_ASSIGNABLE`

#### Scenario: Desmapear técnico siempre permitido
- **GIVEN** un técnico con una cuadrilla mapeada
- **WHEN** se mapea con `iclassTeamLogin = null`
- **THEN** el sistema persiste `iclassTeamLogin = null`
- **AND** responde 200

#### Scenario: Técnico inexistente
- **GIVEN** un `userId` que no corresponde a ningún `RbacUser`
- **WHEN** se intenta mapearlo
- **THEN** el sistema responde 404

#### Scenario: Listado de mapeos degrada cuadrilla inactiva
- **GIVEN** un técnico mapeado a una cuadrilla que luego fue desactivada por el sync (`active === false`)
- **WHEN** se lista el mapeo de técnicos
- **THEN** la fila incluye `{ iclassTeamLogin, teamName, teamActive: false }`
- **AND** el front-end la marca como "cuadrilla inactiva, re-mapeá"

### Requirement: Auto-asignar la cuadrilla a IClass al cambiar el técnico (best-effort)

Cuando el técnico (`assigneeId`) de una tarea CAMBIA mediante `UpdateTask`, el sistema DEBE intentar empujar la cuadrilla mapeada del técnico a la OS de IClass, de forma BEST-EFFORT: la asignación local del técnico NUNCA se aborta por un fallo del lado IClass, y cada intento queda registrado.

#### Scenario: Auto-asignación exitosa
- **GIVEN** una tarea con `iclassOrderCode` no nulo y `generalStatus === 'open'`
- **AND** el flag `iclass-assign-action` está habilitado
- **AND** el nuevo técnico tiene `iclassTeamLogin` mapeada a una cuadrilla `active && selectable`
- **AND** la OS en IClass NO está en estado terminal (`statusCode !== '7'`)
- **WHEN** `UpdateTask` cambia el `assigneeId` a ese técnico
- **THEN** el sistema llama `updateServiceOrder({ serviceOrderCode, requiredTeam: login })`
- **AND** registra una actividad `iclass_team_auto_assigned`
- **AND** la asignación local del técnico se persiste

#### Scenario: Flag de acción apagado no toca IClass
- **GIVEN** el flag `iclass-assign-action` está deshabilitado (default OFF)
- **WHEN** `UpdateTask` cambia el `assigneeId`
- **THEN** el sistema NO llama a IClass
- **AND** la asignación local del técnico se persiste igual

#### Scenario: Técnico sin cuadrilla mapeada no dispara push
- **GIVEN** el nuevo técnico no tiene `iclassTeamLogin`
- **WHEN** `UpdateTask` cambia el `assigneeId`
- **THEN** el sistema NO llama a IClass (skip `no-mapping`)
- **AND** la asignación local se persiste

#### Scenario: Tarea sin OS en IClass no dispara push
- **GIVEN** una tarea con `iclassOrderCode` nulo
- **WHEN** `UpdateTask` cambia el `assigneeId` a un técnico con cuadrilla
- **THEN** el sistema NO llama a IClass (skip `no-order-code`)

#### Scenario: Cuadrilla mapeada quedó inactiva → degrada
- **GIVEN** el técnico tiene `iclassTeamLogin` apuntando a una cuadrilla que el sync desactivó (`active === false`)
- **WHEN** `UpdateTask` cambia el `assigneeId` a ese técnico
- **THEN** el sistema NO empuja la cuadrilla inactiva a IClass (skip `team-inactive`)
- **AND** la asignación local se persiste
- **AND** se registra el skip

#### Scenario: OS ya cerrada en IClass → no asigna
- **GIVEN** la OS en IClass está en estado terminal (`statusCode === '7'`)
- **WHEN** `UpdateTask` cambia el `assigneeId`
- **THEN** el sistema NO llama `updateServiceOrder` (skip `order-closed`)

#### Scenario: IClass rechaza el push → asignación local sobrevive
- **GIVEN** todas las precondiciones verdes
- **WHEN** `updateServiceOrder` falla con rechazo de negocio (`IClassRejectedError`)
- **THEN** el sistema NO aborta `UpdateTask`
- **AND** la asignación local del técnico se persiste
- **AND** registra una actividad `iclass_team_auto_assign_failed` con el detalle del rechazo

#### Scenario: IClass no disponible → asignación local sobrevive
- **GIVEN** todas las precondiciones verdes
- **WHEN** `updateServiceOrder` falla con `IClassUnavailableError` (5xx/timeout/auth)
- **THEN** el sistema NO aborta `UpdateTask`
- **AND** la asignación local del técnico se persiste
- **AND** registra el fallo

#### Scenario: Cambio de assignee NO real no dispara push
- **GIVEN** el form de edición reenvía el `assigneeId` actual sin cambiarlo
- **WHEN** `UpdateTask` procesa el body
- **THEN** el sistema NO invoca el auto-asignar (no-op)

#### Scenario: Desasignar técnico no toca IClass
- **GIVEN** una tarea con técnico asignado
- **WHEN** `UpdateTask` setea `assigneeId = null`
- **THEN** el sistema NO llama a IClass (skip `no-mapping`)

### Requirement: Togglear los feature flags de acciones de OS desde la config

El sistema DEBE exponer, en la configuración de IClass, toggles para los flags de runtime `iclass-close-action` y `iclass-assign-action`, agrupados aparte del flag de despacho `iclass-integration`.

#### Scenario: Encender el flag de asignación
- **GIVEN** el flag `iclass-assign-action` está OFF
- **WHEN** un usuario con permiso `admin.flags` lo enciende desde la sub-tab "Acciones de OS"
- **THEN** el sistema hace `PATCH /api/admin/feature-flags/iclass-assign-action` con `{ enabled: true }`
- **AND** el flag queda habilitado

#### Scenario: El flag de despacho permanece en su sección
- **GIVEN** la config de IClass
- **WHEN** se renderizan las sub-tabs
- **THEN** `iclass-integration` sigue en "Integración"
- **AND** `iclass-close-action` / `iclass-assign-action` aparecen en "Acciones de OS"

### Requirement: Dar visibilidad de lo que se despacha a IClass

El sistema DEBE exponer una vista consolidada, por proyecto, de lo que se envía a IClass al despachar una tarea de cliente, marcando qué es configurable y qué está hardcodeado, y dejando explícito que el estado inicial lo asigna IClass.

#### Scenario: Preview de un proyecto mapeado
- **GIVEN** un proyecto con `iclassSoType` mapeado
- **WHEN** un usuario con permiso `iclass.read` consulta el preview de despacho
- **THEN** la fila incluye el `soType` (code + descripción), `nodeResolution = 'by-customer-city'`, `customerCodeSource`, `phoneSource`, `soCodeSource`
- **AND** `initialStatus = 'assigned-by-iclass'` (Prominense no envía estado inicial)

#### Scenario: Preview de un proyecto sin mapeo de tipo de OS
- **GIVEN** un proyecto sin `iclassSoType`
- **WHEN** se consulta el preview
- **THEN** la fila incluye `soType: null` para que se vea que está sin mapear

#### Scenario: Los campos hardcodeados se muestran sin volverse configurables
- **GIVEN** el preview de despacho
- **WHEN** se renderiza
- **THEN** muestra el `phone` y `customerCode` hardcodeados de RED/FIBRA (`'0000000000'`, `'NETWORK'`) como informativos
- **AND** NO ofrece editarlos (fuera de alcance de este change)
