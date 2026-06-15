# Spec — Contract History Operator (#117)

## ADDED Requirement: El operador (actorName) de cada evento de servicio DEBE resolverse al leer
El endpoint `GET /api/contracts/:contractId/service-history` DEBE poblar el campo `actorName` de cada evento con el nombre del operador que ejecutó la acción, resolviéndolo desde el snapshot persistido y, cuando el snapshot esté vacío pero exista `actorId`, desde la relación `actor` (RbacUser.login) vía JOIN. El sistema NO DEBE alterar el shape del wire contract (`actorName` sigue siendo `string`).

### Scenario: Evento no-TV con snapshot poblado muestra el operador
- **GIVEN** un servicio no-TV con un evento `activated` cuyo `actorName` snapshot = "jperez"
- **WHEN** un usuario con `clients.read` hace `GET /api/contracts/:contractId/service-history`
- **THEN** el evento correspondiente del item incluye `actorName: "jperez"`

### Scenario: Evento TV con snapshot poblado muestra el operador
- **GIVEN** un servicio TV (`tvLogin` no nulo) con un evento `baja` en `tv_activation_events` cuyo `actorName` snapshot = "operadora1"
- **WHEN** se consulta el historial
- **THEN** el evento mapeado (`deactivated`) incluye `actorName: "operadora1"` y conserva el `cic`

### Scenario: Evento con snapshot vacío pero actorId presente resuelve por JOIN
- **GIVEN** un evento (TV o no-TV) con `actorName = ''` y `actorId` apuntando a un `RbacUser` con `login = "admin"`
- **WHEN** se consulta el historial
- **THEN** el evento incluye `actorName: "admin"` (resuelto vía la relación `actor` → `RbacUser.login`)
- **AND** el snapshot tiene prioridad: si `actorName` snapshot NO está vacío, se usa el snapshot aunque exista `actorId` (semántica snapshot preservada — sobrevive rename del user)

### Scenario: Evento con actorId nulo (system-initiated o user borrado) degrada en blanco
- **GIVEN** un evento con `actorName = ''` y `actorId = null`
- **WHEN** se consulta el historial
- **THEN** el evento incluye `actorName: ''` (no hay fuente para el operador; degradación elegante)
- **AND** la respuesta NO falla ni omite el evento

### Scenario: Evento sintetizado (legacy sin fila) NO tiene operador y NO se inventa
- **GIVEN** un servicio inactivo SIN filas de evento (alta/baja anteriores a la migración del ledger)
- **WHEN** se consulta el historial
- **THEN** los eventos sintetizados de `createdAt`/`deactivatedAt` incluyen `actorName: ''`
- **AND** el sistema NO intenta resolver un operador para eventos sintéticos (no existe el dato)

## ADDED Requirement: El operador DEBE persistirse en el snapshot al registrar un evento desde una ruta autenticada
Toda ruta autenticada que dispare el registro de un evento de servicio (alta no-TV, update, remove, alta TV, baja TV) DEBE threadear el actor desde `req.user` de modo que `actorName` se persista con el `username`/`login` del operador y `actorId` con su id. El registro de evento DEBE ser best-effort (un fallo del recorder NO aborta la operación principal).

### Scenario: Alta de servicio no-TV persiste el operador
- **GIVEN** un operador autenticado (`req.user = { id, username: "jperez" }`)
- **WHEN** hace `POST /api/contracts/:contractId/services`
- **THEN** el evento `activated` registrado tiene `actorName: "jperez"` y `actorId` = id del operador

### Scenario: Baja/reactivación de servicio no-TV persiste el operador
- **GIVEN** un operador autenticado y un servicio `active`
- **WHEN** hace `PATCH .../services/:id` con `status: 'inactive'` (y luego `'active'`)
- **THEN** los eventos `deactivated` y `reactivated` registrados tienen el `actorName`/`actorId` del operador

### Scenario: Eliminación de servicio no-TV persiste el operador
- **GIVEN** un operador autenticado y un servicio `active`
- **WHEN** hace `DELETE .../services/:id`
- **THEN** el evento `deactivated` registrado tiene el `actorName`/`actorId` del operador

### Scenario: Alta TV (register) persiste el operador
- **GIVEN** un operador autenticado
- **WHEN** hace `POST /api/gigared/customers/:id/register` con `contractId`
- **THEN** el evento `alta` (o `reactivacion`) en `tv_activation_events` tiene el `actorName`/`actorId` del operador

### Scenario: Baja TV (cancel async) persiste el operador
- **GIVEN** un operador autenticado
- **WHEN** hace `POST /api/gigared/customers/:id/cancel` y el runner completa la baja
- **THEN** el evento `baja` registrado por `CancelTvJobRunner` tiene el `actorName`/`actorId` capturado de `req.user` ANTES de responder

### Scenario: El registro del evento es best-effort
- **GIVEN** un recorder de eventos que lanza una excepción en `record`
- **WHEN** se ejecuta la operación principal (alta/baja/update/remove/register/cancel)
- **THEN** la operación principal completa normalmente (el fallo del recorder se loguea con `console.warn`, no propaga)

## ADDED Requirement: El viaje completo (SEAM) del operador DEBE quedar verificado punta a punta
El sistema DEBE garantizar, mediante un test de integración por ruta real, que el operador viaja de extremo a extremo: ruta autenticada → use-case real → repo in-memory → lectura por la ruta de historial → `actorName` poblado en la respuesta. NO se DEBE testear solo las puntas por separado.

### Scenario: Viaje completo — alta no-TV y su aparición en el historial
- **GIVEN** la app Express real con repos in-memory inyectados y un usuario autenticado "jperez"
- **WHEN** se hace `POST /api/contracts/:contractId/services` y luego `GET /api/contracts/:contractId/service-history`
- **THEN** el evento `activated` del item correspondiente tiene `actorName: "jperez"` en la respuesta HTTP

### Scenario: Viaje completo — JOIN resuelve operador de snapshot vacío
- **GIVEN** un evento sembrado con `actorName: ''` y `actorId` de un RbacUser "admin" (simulando un evento viejo)
- **WHEN** se hace `GET /api/contracts/:contractId/service-history`
- **THEN** el evento incluye `actorName: "admin"` (resuelto por el adapter al leer)

## ADDED Requirement: La seguridad y los permisos existentes NO DEBEN cambiar
El JOIN al operador NO DEBE exponer información sensible ni alterar el gating de permisos.

### Scenario: Permiso requerido sin cambios
- **GIVEN** un usuario sin `clients.read`
- **WHEN** hace `GET /api/contracts/:contractId/service-history`
- **THEN** responde 403 PERMISSION_DENIED
- **AND** sin autenticación responde 401

### Scenario: tvPassword sigue sin exponerse
- **GIVEN** un servicio TV con `tvLogin` y `tvPassword` seteados
- **WHEN** se consulta el historial (con el operador resuelto)
- **THEN** ningún item ni evento de la respuesta contiene la propiedad `tvPassword`
