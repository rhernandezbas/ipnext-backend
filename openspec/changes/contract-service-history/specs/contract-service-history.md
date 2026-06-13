# Spec — Contract Service History (#73)

## ADDED Requirement: Historial de servicios del contrato
El sistema DEBE exponer el historial completo de servicios de un contrato, incluyendo los servicios dados de baja (inactivos), sin exponer credenciales sensibles.

### Scenario: Listar historial con servicios activos e inactivos
- **GIVEN** un contrato con 1 servicio `active` y 1 servicio `inactive`
- **WHEN** un usuario con `clients.read` hace `GET /api/contracts/:contractId/service-history`
- **THEN** responde 200 con un array de 2 items, cada uno con `{ name, status, notes, tvLogin, createdAt, deactivatedAt }`
- **AND** el item inactivo tiene `deactivatedAt` no nulo; el activo tiene `deactivatedAt = null`

### Scenario: tvPassword nunca se expone
- **GIVEN** un servicio con `tvLogin` y `tvPassword` seteados
- **WHEN** se consulta el historial
- **THEN** el item incluye `tvLogin` pero el objeto NO tiene la propiedad `tvPassword`

### Scenario: deactivatedAt se setea al inactivar
- **GIVEN** un servicio `active`
- **WHEN** se actualiza su status a `inactive` (vía UpdateContractService o flujo TV)
- **THEN** `deactivatedAt` queda seteado con la fecha del cambio
- **AND** si luego se reactiva (`active`), `deactivatedAt` vuelve a `null`

### Scenario: Sin historial → array vacío
- **GIVEN** un contrato sin servicios
- **WHEN** se consulta el historial
- **THEN** responde 200 con array vacío

### Scenario: Permiso requerido (dos capas)
- **GIVEN** un usuario sin `clients.read`
- **WHEN** hace `GET /api/contracts/:contractId/service-history`
- **THEN** responde 403 PERMISSION_DENIED
- **AND** sin autenticación responde 401
