<!-- generated from engram topic_key: sdd/inventory-edit-and-match/proposal -->
## Proposal — inventory-edit-and-match

> Refinamiento del #8 (`service-inventory-management`, ya en prod). Multi-repo (BE + FE). Strict TDD. Migraciones aditivas (solo RBAC si hace falta). Surge de un caso real: tarea 4691 con un ONU confirmado que era antena.

### Why
Dos problemas detectados con el inventario ya en prod:

1. **Inconsistencia de tipo tras corregir.** Hay DOS registros para un equipo confirmado: la **sugerencia** (`TaskInventorySuggestion.deviceType`, congelada al confirmar — la muestra la card "✓ Confirmado" en el tab de inventario de la tarea, `SuggestionCard.tsx:70`) y el **ítem del contrato** (`ContractInstalledItem.type`, editable). Hoy editar el ítem del contrato NO actualiza la sugerencia → la card de la tarea sigue mostrando el tipo viejo (ONU) mientras el contrato + el sidebar muestran el corregido (ANTENA). Caso real: tarea 4691.

2. **No hay detección de duplicados.** Al confirmar/ver sugerencias no se cruza contra el inventario actual del contrato. Si el mismo aparato físico (mismo SN/MAC) ya está instalado, no se avisa → riesgo de cargar dos veces el mismo equipo.

### What changes

**F1 — Editar el tipo de un equipo confirmado (admin), con sincronización**
- Nuevo use-case `CorrectConfirmedDeviceType` (o `UpdateConfirmedSuggestionType`): dado un `suggestionId` (DEVICE, ya confirmada) + un `type` nuevo, valida contra el `DeviceTypeCatalog` y **actualiza AMBOS registros de una**: `TaskInventorySuggestion.deviceType` y el `ContractInstalledItem` linkeado (vía `suggestion.confirmedItemId`). Así queda consistente en card + contrato + sidebar.
- Ruta `PATCH /scheduling/:taskId/inventory/suggestions/:suggestionId/type` (o similar) gated **`inventory.manage`** (admin) — corregir un tipo ya confirmado es acción de administración. Tipo inválido → 422 `INVALID_ITEM_TYPE`. Sugerencia no confirmada / no DEVICE → error claro.
- FE: en la card resuelta del tab de inventario de la tarea (`SuggestionCard` variante resuelta), agregar un control de **edición de tipo visible solo con `inventory.manage`** (`<Can permission="inventory.manage">`). Al guardar → invalida las queries de sugerencias + inventario del contrato.

**F2 — Comparativa inteligente contra el inventario del contrato (match por SN/MAC)**
- Enriquecer el listado de sugerencias (`ListTaskInventorySuggestions` gana una dep `ContractInventoryRepository`; o un use-case nuevo `ListTaskInventorySuggestionsWithMatch`) para cruzar cada sugerencia **DEVICE** contra los `ContractInstalledItem` activos del contrato de la tarea:
  - **Mismo SN o MAC** (normalizado, case-insensitive) → `match: 'same_device'` → "Ya instalado (el mismo equipo)".
  - **Mismo tipo, distinto SN/MAC** → `match: 'same_type'` → "Ya hay un/a {tipo} (posible reemplazo)".
  - Sin coincidencia → `match: null`.
- El DTO de la sugerencia gana un campo `match` (enum + el id/serial del ítem coincidente para referencia). Solo lectura (`inventory.read`).
- FE: badge/indicador en la card de la sugerencia ("⚠️ Ya instalado: el mismo equipo" / "Ya hay un/a {tipo}") para que el operador no recargue duplicados.

### Decisiones (confirmadas con el usuario)
- **Criterio de match**: por **SN/MAC = aparato físico** (no por tipo solo). Mismo tipo distinto SN = "posible reemplazo", no "el mismo".
- **Permiso de edición**: `inventory.manage` (admin). El match es `inventory.read`.
- **Sincronización**: editar actualiza sugerencia + ítem del contrato a la vez (una sola fuente de verdad de cara al usuario).

### Out of scope
- Reemplazo formal de equipo (`status='replaced'` + tracking del reemplazante) — el match solo AVISA "posible reemplazo", no ejecuta el reemplazo.
- Match de materiales (es por consumo, no por identidad física) — solo equipos DEVICE.
- Edición de SN/MAC desde la card (solo el tipo; SN/MAC se editan en `ServiceInventorySection` como hoy).

### Riesgos & rollback
- Aditivo: el campo `match` es derivado (no persiste), F1 toca 2 updates existentes. Sin migración de schema (a lo sumo ninguna; `inventory.manage` ya existe). Bajo riesgo.
- F1 toca `setStatus`/los repos de sugerencia + inventario (ya en prod) → Strict TDD + suite como red.
- Orden de deploy: BE antes que FE; el FE degrada (sin badge / sin botón) si el BE no está.
