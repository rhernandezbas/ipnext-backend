# recapture (delta)

## MODIFIED Requirement: Pool de operadores asignables en recaptación
El pool de operadores asignables a un lead de recaptación DEBE ser todo usuario ACTIVO que
tenga AL MENOS UN rol y NINGUNO de sus roles sea técnico (`tecnico`). Un usuario activo sin
roles NO es asignable. `noc` SÍ es asignable — sólo `tecnico` se excluye. La regla se aplica
en DOBLE CAPA: el FE la usa para poblar los selects, y el BE la re-valida y rechaza con HTTP
422 (`RECAPTURE_ASSIGNEE_NOT_ALLOWED`). Desasignar (`operatorId: null`) NO dispara el chequeo.

### Scenario: asignar a un usuario con rol no-técnico (ventas/admin/noc) → OK
- **WHEN** se asigna un lead a un usuario activo cuyo set de roles es `['noc']` (o `['ventas']`, `['administrador']`)
- **THEN** la asignación procede (status → `en_gestion`) y responde 200

### Scenario: asignar a un técnico → rechazado 422
- **WHEN** se asigna un lead a un usuario activo con rol `['tecnico']` (o `['ventas','tecnico']`)
- **THEN** se lanza `RecaptureAssigneeNotAllowedError`
- **AND** la ruta responde **422** con `code: 'RECAPTURE_ASSIGNEE_NOT_ALLOWED'`

### Scenario: asignar a un usuario SIN roles → rechazado 422
- **WHEN** se asigna un lead a un usuario activo cuyo set de roles es `[]`
- **THEN** se lanza `RecaptureAssigneeNotAllowedError` (422)

### Scenario: usuario inexistente → existencia gana sobre pool
- **WHEN** se asigna un lead a un `operatorId` que no corresponde a ningún usuario
- **THEN** se lanza `ReferenceNotFoundError` (la existencia se valida ANTES del rol)
- **AND** la ruta responde **400** con `code: 'REFERENCE_NOT_FOUND'` (no 422)

### Scenario: desasignar omite el chequeo de pool
- **WHEN** se llama assign con `operatorId: null`
- **THEN** no se consulta rol ni existencia; el lead queda desasignado (status → `nuevo`) y responde 200

### Scenario: bulk con target no-asignable no toca ningún lead
- **WHEN** un assign-bulk apunta a un target técnico (o sin roles) con N leads
- **THEN** el chequeo corre UNA vez ANTES del loop → 422, y NINGÚN lead cambia de asignación

## ADDED Requirement: Helper de roles técnicos en el dominio
El dominio DEBE exponer `TECHNICAL_ROLE_CODES` (`['tecnico']`) e `isTechnicalRoleSet(codes)`
como fuente de verdad de la exclusión, y un puerto `UserRoleLookup { listRoleCodes(userId): Promise<string[]> }`
para que los use cases resuelvan los códigos de rol sin depender de infraestructura.

### Scenario: isTechnicalRoleSet detecta el rol técnico en el set
- **WHEN** `codes = ['tecnico']` o `['ventas','tecnico']`
- **THEN** `isTechnicalRoleSet(codes)` es `true`

### Scenario: isTechnicalRoleSet es false para sets no-técnicos o vacíos
- **WHEN** `codes = ['noc']` o `[]`
- **THEN** `isTechnicalRoleSet(codes)` es `false`
