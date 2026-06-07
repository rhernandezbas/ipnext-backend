# Spec delta — inventory-confirm-validation (#18)

Capability: confirmación de sugerencias de inventario (guard de datos mínimos antes de promover a ítem/consumo).

## ADDED Requirements

### Requirement: REQ-CONFIRM-VAL-1 — DEVICE requiere SN o MAC
No se puede confirmar una sugerencia DEVICE sin al menos un identificador físico.

#### Scenario: DEVICE sin SN ni MAC → rechazo
- **WHEN** se confirma (`execute` o `replace`) un DEVICE con `serialNumber` y `mac` ambos vacíos (null o solo espacios)
- **THEN** lanza `IncompleteSuggestionError` y NO crea el `ContractInstalledItem` ni marca la sugerencia confirmada.

#### Scenario: DEVICE con SN (o MAC) → confirma
- **WHEN** el DEVICE tiene `serialNumber` o `mac` no vacío
- **THEN** confirma con el comportamiento actual.

### Requirement: REQ-CONFIRM-VAL-2 — MATERIAL requiere descripción
No se puede confirmar una sugerencia MATERIAL sin descripción.

#### Scenario: MATERIAL sin descripción → rechazo
- **WHEN** se confirma un MATERIAL con `materialDesc` vacío (null o solo espacios)
- **THEN** lanza `IncompleteSuggestionError` y NO crea el `TaskMaterialConsumption`.

#### Scenario: MATERIAL con descripción → confirma
- **WHEN** el MATERIAL tiene `materialDesc` no vacío
- **THEN** confirma (la cantidad mantiene su default actual si falta).

### Requirement: REQ-CONFIRM-VAL-3 — Fail-closed en el backend (422)
El guard vive en el caso de uso, no solo en el front.

#### Scenario: error tipado → HTTP 422
- **WHEN** `ConfirmInventorySuggestion.execute`/`replace` lanza `IncompleteSuggestionError` (`code: 'SUGGESTION_INCOMPLETE'`)
- **THEN** la API responde **422** con `{ error, code: 'SUGGESTION_INCOMPLETE' }` (vía el errorHandler central).

### Requirement: REQ-CONFIRM-VAL-4 — El FE bloquea la confirmación incompleta
El botón de confirmar se deshabilita cuando faltan los mínimos, con un hint.

#### Scenario: DEVICE sin SN/MAC → botón deshabilitado + hint
- **WHEN** se muestra una `SuggestionCard` DEVICE pending sin SN ni MAC
- **THEN** "Confirmar"/"Agregar" quedan deshabilitados y se muestra un hint ("falta SN o MAC"); "Descartar" sigue habilitado.

#### Scenario: MATERIAL sin descripción → botón deshabilitado
- **WHEN** se muestra una `SuggestionCard` MATERIAL pending sin descripción
- **THEN** "Confirmar" queda deshabilitado con su hint.

## Out of scope
- Alta/edición manual de SN (#19, reusa esta validación).
- Cambiar el OCR; permisos (se reusa `inventory.write`).
- Forzar cantidad > 0 en MATERIAL (la cantidad mantiene su default 1).
