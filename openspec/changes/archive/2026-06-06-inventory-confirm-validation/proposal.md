# Proposal — inventory-confirm-validation (#18)

Mode: interactive · Store: hybrid (openspec + engram `sdd/inventory-confirm-validation/*`).

## Why

En la confirmación de inventario de una OS (visto en la **4175**) un ítem puede quedar **confirmado pero sin data**: hoy `ConfirmInventorySuggestion` NO valida datos mínimos antes de crear el `ContractInstalledItem` (DEVICE) o el `TaskMaterialConsumption` (MATERIAL). Se puede confirmar:
- un **DEVICE sin SN ni MAC** (queda un equipo instalado sin identidad física), o
- un **MATERIAL sin descripción** (cae al fallback `OTRO`).

El usuario lo pidió explícito durante la charla del #22: *"al darle confirmar, si no hay SN o MAC, no debería dejar asociar"*. Es además el prerequisito del #19 (alta manual reusa esta validación).

## Decisiones (regla a confirmar)

- **AD-1 — Regla de datos mínimos**:
  - **DEVICE**: requiere `serialNumber` **o** `mac` (al menos uno, no vacío tras trim). Sin ambos → rechazo.
  - **MATERIAL**: requiere `materialDesc` no vacío (tras trim). Sin descripción → rechazo. La cantidad mantiene su default actual (1 cuando falta) — el bug real es "sin descripción", no la fuerzo para no romper los materiales de IClass que vienen sin qty explícita.
- **AD-2 — Fail-closed en el backend**: el guard vive en `ConfirmInventorySuggestion` (`execute` + `replace`), NO solo en el front. Una ruta protegida solo en el FE es un agujero.
- **AD-3 — Error de dominio tipado**: nuevo `IncompleteSuggestionError` (`code: 'SUGGESTION_INCOMPLETE'`) → HTTP 422, siguiendo el patrón de los demás errores de `domain/errors/inventory`.

## What changes

### Backend
- Nuevo `IncompleteSuggestionError` en `domain/errors/inventory.ts`.
- `ConfirmInventorySuggestion`: guard de datos mínimos al inicio de `execute()` y `replace()` (antes de cualquier creación), por `kind`. Lanza `IncompleteSuggestionError` si faltan.
- Ruta de confirm: mapear `IncompleteSuggestionError` → `422` con `{ error, code }` (patrón existente `instanceof`).

### Frontend
- `TaskInventorySuggestions` / `SuggestionCard`: **deshabilitar** el botón "Confirmar" cuando la sugerencia no cumple los mínimos (DEVICE sin SN/MAC, MATERIAL sin desc) + un hint de por qué. Si el backend igual rechaza (race), mostrar el mensaje del 422.

## Impact

- **Out of scope**: el alta/edición manual de SN (#19, que vendrá después y reusa esta validación); cambiar el OCR; permisos (se reusa `inventory.write`).
- **Riesgo**: bajo. Es un guard nuevo que solo RECHAZA confirmaciones inválidas; no cambia el camino feliz. Posible impacto: si hoy se confiaba en confirmar incompletos, eso deja de andar (es justamente el objetivo).
- **Datos existentes**: no se tocan ítems ya confirmados (solo afecta confirmaciones nuevas). Los DEVICE incompletos viejos se completan con #19 o se descartan.
- **Sin migración.**

## A verificar en apply
- El path `link_existing` (same_device) implica SN/MAC (hubo match) — confirmar que el guard no lo rompe.
- El mapeo exacto de errores → HTTP en la ruta de confirm (archivo + status).
- Cómo confirma el FE hoy (componente + hook) para ubicar el disable.
