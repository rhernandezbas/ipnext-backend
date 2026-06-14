# Spec — Service History Ledger (#110)

## ADDED Requirement: Ledger append-only de eventos de servicio (no-TV)
El sistema DEBE registrar, de forma append-only, cada cambio de estado de un `ContractService` no-TV (alta, baja, reactivación), preservando el actor y el momento, sin pisar ni borrar eventos previos.

### Scenario: Alta inicial registra `activated`
- **GIVEN** un contrato y un servicio del catálogo no-TV
- **WHEN** se agrega el servicio al contrato (`AddContractService`)
- **THEN** se registra un evento `{ eventType: 'activated', occurredAt, actorName }` en `contract_service_events`
- **AND** la operación de alta completa aunque el registro del evento falle (best-effort)

### Scenario: Baja registra `deactivated`, reactivación registra `reactivated`
- **GIVEN** un servicio `active`
- **WHEN** se cambia su status a `inactive` (`UpdateContractService`)
- **THEN** se registra un evento `deactivated`
- **AND** cuando luego se cambia a `active`, se registra un evento `reactivated`
- **AND** el ledger conserva AMBOS eventos más el `activated` original (3 filas, ninguna pisada)

### Scenario: Update sin transición de status NO registra evento
- **GIVEN** un servicio `active`
- **WHEN** se hace `UpdateContractService` cambiando solo `notes` (sin `status`)
- **THEN** NO se registra ningún evento

### Scenario: Eliminación de servicio activo registra `deactivated`
- **GIVEN** un servicio `active`
- **WHEN** se elimina (`RemoveContractService`)
- **THEN** se registra un evento `deactivated`
- **AND** eliminar un id inexistente es no-op y NO registra evento (idempotencia preservada)

## ADDED Requirement: Historial de servicios con secuencia temporal de eventos
El endpoint `GET /api/contracts/:contractId/service-history` DEBE devolver, por cada servicio del contrato (activo + inactivo), su estado actual MÁS la secuencia cronológica completa de sus cambios de estado, cruzando la fuente correcta según el tipo de servicio, sin exponer credenciales sensibles.

### Scenario: Servicio no-TV muestra su secuencia de eventos genéricos
- **GIVEN** un servicio no-TV con eventos `activated`, `deactivated`, `reactivated` en `contract_service_events`
- **WHEN** un usuario con `clients.read` hace `GET /api/contracts/:contractId/service-history`
- **THEN** el item del servicio incluye `events` = `[activated, deactivated, reactivated]` ordenados por `occurredAt` ASC
- **AND** conserva los campos #73 (`name`, `status`, `notes`, `tvLogin`, `createdAt`, `deactivatedAt`)

### Scenario: Servicio TV cruza con tv_activation_events
- **GIVEN** un servicio TV (`tvLogin` no nulo) con eventos `alta` y `baja` en `tv_activation_events` para ese `contractId`
- **WHEN** se consulta el historial
- **THEN** el item TV incluye `events` mapeados a `[{eventType:'activated', cic}, {eventType:'deactivated', cic}]` (alta→activated, baja→deactivated, reactivacion→reactivated)
- **AND** NO se leen eventos de `contract_service_events` para el servicio TV (no se duplica)

### Scenario: Servicio sin eventos (legacy pre-migración) degrada con elegancia
- **GIVEN** un servicio `inactive` sin filas de evento (inactivado antes de la migración)
- **WHEN** se consulta el historial
- **THEN** `events` se sintetiza con `activated` (de `createdAt`) y `deactivated` (de `deactivatedAt`)
- **AND** un servicio `active` sin eventos muestra `events = [activated(createdAt)]`

### Scenario: tvPassword nunca se expone
- **GIVEN** un servicio TV con `tvLogin` y `tvPassword` seteados
- **WHEN** se consulta el historial
- **THEN** ningún item ni evento de la respuesta contiene la propiedad `tvPassword`
- **AND** `tvLogin` SÍ se expone a nivel item

### Scenario: Permiso requerido (dos capas)
- **GIVEN** un usuario sin `clients.read`
- **WHEN** hace `GET /api/contracts/:contractId/service-history`
- **THEN** responde 403 PERMISSION_DENIED
- **AND** sin autenticación responde 401

### Scenario: Contrato sin servicios → array vacío
- **GIVEN** un contrato sin servicios
- **WHEN** se consulta el historial
- **THEN** responde 200 con array vacío
