# Delta spec — iclass-integration (iclass-contract-code)

## MODIFIED Requirement: customerCode de la OS de tarea de cliente

Al crear una Service Order en IClass para una tarea de **cliente** (`kind !== 'network'`), el `customerCode` enviado DEBE identificar al CONTRATO cuando la tarea está asociada a uno.

### Scenario: tarea con contrato → viaja el código del contrato
- GIVEN una tarea de cliente con `contractCode = "CTR-204382"` y `customerCode = "CLI-99"`
- WHEN se despacha a IClass
- THEN el `customerCode` del payload de `createServiceOrder` es `"CTR-204382"`

### Scenario: tarea sin contrato → fallback al código de cliente (back-compat)
- GIVEN una tarea de cliente con `contractCode = null` y `customerCode = "CLI-99"`
- WHEN se despacha a IClass
- THEN el `customerCode` del payload es `"CLI-99"`

### Scenario: tarea de red → sin cambios
- GIVEN una tarea con `kind = "network"` y un networkSite con `iclassNodeCode = "NODO-1"`
- WHEN se despacha a IClass
- THEN el `customerCode` del payload es `"NODO-1"` (la lógica de red no se altera)

## ADDED Requirement: ScheduledTask.contractCode

La entidad `ScheduledTask` DEBE exponer `contractCode: string | null`, derivado de `Contract.grContratoId` vía el JOIN del contrato. Es `null` cuando la tarea no tiene contrato o el contrato no tiene `grContratoId`.

## ADDED Requirement: el DTO de contrato expone el código

El DTO de resumen de contrato DEBE exponer `code: string | null` (= `grContratoId`) para que el front pueda mostrarlo en la card del contrato.
