# plan-management (delta)

## MODIFIED Requirement: Sincronización de planes con el RADIUS
Prominense DEBE sincronizar con el orchestrator (radgroupreply) los planes COMERCIALES, pero NO los planes
de ENFORCEMENT, identificados por su CÓDIGO (`IP-REDUCCION`, `IP-BAJA`), que el orchestrator posee y
reserva. El criterio es el código (inmutable), NO la categoría (editable).

### Scenario: crear un plan con código de enforcement no lo sincroniza
- **WHEN** se crea un plan con código `IP-REDUCCION` o `IP-BAJA`
- **THEN** NO se llama `syncPlan` en el orchestrator
- **AND** el plan se crea en la DB local de Prominense

### Scenario: el criterio es el código, no la categoría
- **WHEN** se crea un plan con código de enforcement pero categoría no-`Corte` (ej. `Air`)
- **THEN** igual NO se llama `syncPlan` (el orchestrator rechazaría el código reservado)

### Scenario: editar un plan de enforcement no lo sincroniza
- **WHEN** se actualiza un plan cuyo código es de enforcement (el código es inmutable)
- **THEN** NO se llama `syncPlan` en el orchestrator

### Scenario: borrar un plan de enforcement no lo borra del RADIUS
- **WHEN** se elimina un plan con código de enforcement
- **THEN** NO se llama `deletePlan` en el orchestrator
- **AND** el plan se borra de la DB local

### Scenario: los planes comerciales siguen sincronizándose
- **WHEN** se crea o edita un plan con código NO reservado (aunque su categoría fuese `Corte`)
- **THEN** se llama `syncPlan` con los valores correctos
