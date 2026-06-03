<!-- generated from engram topic_key: sdd/inventory-confirm-dedup-replace/proposal -->
## Proposal — inventory-confirm-dedup-replace

> Sigue a `inventory-edit-and-match` (ya en prod). Convierte el match de **aviso visual** en **acción**: frena duplicados y ofrece agregar/reemplazar. Multi-repo (BE + FE). Strict TDD. 1 migración aditiva. Toca el flujo de confirm que YA está en prod → con la suite como red.

### Why
Hoy el match (de `inventory-edit-and-match`) solo AVISA: si el equipo ya está instalado, muestra un badge, pero **igual deja confirmar y crea un duplicado**. Y si hay otro del mismo tipo (SN nuevo), no hay forma de decir "esta reemplaza a la actual" — solo se puede agregar, dejando dos. Falta que el sistema **actúe** sobre el match.

### What changes — comportamiento al confirmar un equipo (DEVICE)
El confirm recalcula el match **server-side** (no confía en el FE) contra los `ContractInstalledItem` **activos** del contrato, y aplica:

| Match | `resolution` | Acción |
|-------|-------------|--------|
| **same_device** (SN/MAC ya instalado) | `add` (o default) | **BLOQUEA** → `DuplicateInstalledItemError` (409). No crea duplicado. |
| **same_device** | `link_existing` | Vincula la sugerencia al ítem existente (`status='confirmed'`, `confirmedItemId`=ítem existente), **NO crea nada**. Limpia la sugerencia. |
| **same_type** (mismo tipo, SN distinto) | `add` | Crea el nuevo (coexisten). |
| **same_type** | `replace` | El ítem actual matcheado → `status='replaced'`; crea el nuevo `active` con `replacesItemId`=el viejo. Retira, no borra. |
| **sin match** | `add` | Crea (como hoy). |

`resolution` es un parámetro nuevo del confirm (default `'add'`, retrocompatible para el flujo automático del cierre).

### What changes — capas

**F1 — Matcher compartido**
- Extraer la lógica de match (hoy en `ListTaskInventorySuggestions.computeMatch`) a un helper puro reutilizable (ej. `src/application/services/matchInstalledItem.ts`): normaliza SN (trim+upper) y MAC (trim+upper+strip `:`/`-`), devuelve `{ status: 'same_device'|'same_type'|null, item }`. Lo consumen `ListTaskInventorySuggestions` (sin cambio de comportamiento) y `ConfirmInventorySuggestion` (nuevo).

**F2 — Confirm con resolución**
- `ConfirmInventorySuggestion` input gana `resolution?: 'add' | 'replace' | 'link_existing'` (default `'add'`). En la rama DEVICE: recalcula el match y aplica la tabla de arriba. MATERIAL queda igual.
- `link_existing`: `setStatus(confirmed, matchedItemId)`, sin crear; devuelve el ítem existente.
- `replace`: `inventory.update(matchedItemId, { status: 'replaced' })` + crea el nuevo con `replacesItemId`. Transaccional en lo posible (o secuencial con la nueva apuntando a la vieja).
- Nuevo error `DuplicateInstalledItemError` (`DUPLICATE_INSTALLED_ITEM`, 409).

**F3 — Modelo: link del reemplazo**
- `ContractInstalledItem` gana `replacesItemId String?` (aditiva, nullable). El ítem nuevo apunta al que retiró → historial "X reemplazó a Y". (Decisión de diseño: columna plana vs self-relation — el design decide; mínimo viable = columna nullable.)

**F4 — Rutas + permisos**
- `add` + `link_existing` → siguen en el endpoint de confirm actual (`POST .../confirm`, gated `scheduling.write`/`taskWrite`).
- `replace` (destructivo: retira un ítem) → **gated `inventory.write`**. Decisión de diseño: endpoint separado `POST .../replace` (guard limpio por middleware) vs check de permiso in-handler en el confirm. Recomendado: **endpoint separado** para que el guard sea declarativo. El confirm rechaza `resolution='replace'` (debe usar el endpoint de replace).

**F5 — FE: botones según el match**
- En la card de sugerencia (pending), los botones dependen del match:
  - **same_device** → "Marcar como ya instalado" (llama confirm con `link_existing`) + Descartar. NO se ofrece el "Confirmar" que duplicaría.
  - **same_type** → "Confirmar" se vuelve elección: **"Agregar"** (confirm `add`) / **"Reemplazar la actual"** (replace, gated `<Can permission="inventory.write">`).
  - **sin match** → "Confirmar" normal (add).
- Hooks para las 3 resoluciones; invalidan sugerencias + inventario del contrato.

### Out of scope
- Reemplazo cuando hay MÚLTIPLES ítems del mismo tipo y es ambiguo cuál retirar → v1 reemplaza el que matcheó el matcher (el primero activo del tipo). Elegir cuál entre varios = futuro.
- Reemplazo de materiales (es consumo, no identidad).
- Deshacer un reemplazo (revertir `replaced`→`active`) = futuro.

### Riesgos & rollback
- Toca `ConfirmInventorySuggestion` (en prod) → Strict TDD, recalcula el match server-side, default `'add'` retrocompatible. La suite existente como red.
- **El confirm es SIEMPRE operator-driven por HTTP** — el cierre automático de IClass solo crea sugerencias `pending`, NUNCA auto-confirma (verificado en el #8). Por eso el 409 en `same_device` no rompe ningún flujo automático: lo dispara una acción del operador, que entonces usa "Marcar como ya instalado" (link_existing). No hay path de cron que se caiga.
- Migración aditiva (`replacesItemId` nullable) → segura.
- Orden de deploy: BE antes que FE; el FE degrada (sin los botones nuevos) si el BE no está.
