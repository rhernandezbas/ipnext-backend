# Proposal: "Agregar por PPPoE" sin duplicados + activo trazable (Cambio A)

## Intent

Cuando se agregan equipos a un contrato por **"Agregar por PPPoE"** (o el **"+ Agregar SN"** manual), garantizar que:

1. **NUNCA** se cree una fila duplicada por la misma **MAC/SN**. Si el equipo ya existe en el contrato → se **completan los datos** que falten en la fila existente (ej. el modelo) y, si estaba dado de baja (`removed`), se **revive** a `active`. Cero duplicados.
2. **Todo** equipo agregado (antena **Y** router — decisión del usuario: *son nuestros*) se materialice como un `InventoryAsset` **trazable** en la ubicación `CLIENTE` del contrato, con su movimiento `INSTALL` en el ledger.

Y, como cierre, **barrer los duplicados que YA existen en prod** (creados por el bug actual), no solo prevenir los nuevos.

## Why

- **El alta por PPPoE bypasea la dedup y el inventario real.** "Agregar por PPPoE" entra por `AddInstalledItemManually` (`src/application/use-cases/AddInstalledItemManually.ts:23-42`) → hace un `INSERT` crudo con `assetId: null` y **sin chequear MAC/SN**. Resultado verificado en vivo: contrato `6290`, MAC `78:8A:20:96:6A:AE` aparece **dos veces** (una vieja `Foto (OCR)`/`removed` sin modelo + una nueva `Manual`/`active` con `LiteBeam 5AC Gen2`).
- **La dedup ya existe, pero no la usa este camino.** `matchInstalledItem` (`src/application/services/matchInstalledItem.ts:36-62`) ya resuelve `same_device` por MAC/SN normalizado (uppercase, sin `:`/`-`). Solo la consume el camino de confirmar sugerencias de tarea (`ConfirmInventorySuggestion`), no el alta contract-scoped.
- **El dual-write al activo ya existe y ya resuelve el "sin SN".** `dualWriteAsset` (`ConfirmInventorySuggestion.ts:135-214`) sintetiza un serial estable para equipos MAC-only (`CII-${uuid}`, `:160-165`), deduplica por serial normalizado o por MAC (`findByNormalizedSerialAny`/`findByMac`, `:170-172`), reusa activos `available` o ya en esta ubicación, y registra el movimiento `INSTALL`. El alta manual/PPPoE **no lo corre** → esos equipos quedan **fuera** del inventario trazable (`assetId: null`).
- **Decisión del usuario: todo equipo es nuestro, el router también** → todos deben volverse `InventoryAsset` (hoy ni la antena ni el router lo son por este camino).
- **Hay duplicados ya en prod** → prevenir no alcanza; hay que limpiar la deuda de datos existente.

## Scope

### In Scope

**Backend (el core):**
- **Use case de alta unificado y dedup-aware** (extiende/reemplaza `AddInstalledItemManually`, consumido por el POST manual **y** por el alta del "Agregar por PPPoE"):
  - Corre `matchInstalledItem` contra los items del contrato.
  - `same_device` (MAC **o** SN coincide) → **enriquecer** la fila existente (rellenar `model`/`type`/`serialNumber`/`mac` faltantes, sin pisar lo que ya tiene) + **revivir** si estaba `removed` (`removed → active`). NO inserta fila nueva. Devuelve el item existente (200), no un 201.
  - `same_type` (mismo tipo, **sin identificador en común**) → caso real: el existente tiene **solo SN** y el PPPoE trae **solo MAC** (el PPPoE nunca trae SN). Acá NO se puede matchear automáticamente (no comparten ningún campo) → el **modal lo SURFACEA al operador**: *"ya hay una ANTENA (SN: X) sin MAC, ¿es esta? Completar su MAC [recomendado] · o Agregar nuevo"*. **Nunca merge silencioso** (puede haber dos del mismo tipo); acción recomendada pre-seleccionada, el operador confirma con 1 click. Si confirma → enriquece (completa la MAC en el existente); si no → alta nueva.
  - Sin match → crear el `ContractInstalledItem` **+ dual-write del `InventoryAsset`** (reusa la lógica de `dualWriteAsset`) → activo `installed` en la `CLIENTE` location del contrato + movimiento `INSTALL`.
- **Extender el match para incluir `removed`**: hoy `matchInstalledItem` se evalúa solo sobre activos. Para "revivir" hay que poder matchear también contra `removed` del mismo contrato (decidir precedencia: activo > removed).
- **Extraer `dualWriteAsset` a un servicio/use case reutilizable** (`InstallContractAsset` o similar) para que lo compartan `ConfirmInventorySuggestion` y el nuevo alta sin duplicar lógica (DIP: vive en application, depende de ports).
- **Reconciliar el activo en el enrich/revive**: si la fila revivida ya tenía `assetId`, traer el activo de `removed/available → installed` por el state machine (`nextStatus`) + movimiento; si no tenía activo (legacy), crearlo.

**Migración de limpieza (deuda existente):**
- **Hand-written, transaccional y con guard** (regla de oro de migraciones destructivas): detectar duplicados por `(contractId, mac_normalizada)` → conservar **una** fila (la `active`/enriquecida; preservar la metadata de aprobación más antigua) → mergear datos faltantes → eliminar/marcar la sobrante. **Se revisa el SQL completo con el usuario antes de pushear.**
- Primero un **conteo** (`SELECT` de cuántos duplicados hay en cuántos contratos) para dimensionar.

**Frontend (`ipnext-frontend`):**
- El **modal de revisión** de "Agregar por PPPoE": cuando un dispositivo matchea uno existente, mostrar **"este equipo ya existe → se completarán los datos"** (en vez de agregar un duplicado) y reflejar el resultado enrich/revive. Manejar el 200-existente del BE sin romper. Skill `ui-ux-pro-max`.

### Out of Scope

- **El modal de "Quitar con destino" + ruteo al ledger** (depósito/técnico/cliente/baja) → **Cambio B** (siguiente).
- **Backfill masivo de `InventoryAsset` para TODOS los CII legacy** existentes (los miles ya cargados sin activo). Acá solo se limpian **duplicados**; el backfill general queda como follow-up explícito.
- Cualquier cambio al ciclo de **baja/retire** (`RemoveInstalledItem`, `RetireContractEquipment`).
- Tocar el camino de sugerencias de tarea (OCR/IClass) salvo la **extracción** compartida de `dualWriteAsset` (refactor sin cambio de comportamiento, cubierto por sus tests).

## Capabilities

### New Capabilities
- Ninguna net-new. Reusa la capability `inventory-asset` (Inventory Foundation / W1) existente.

### Modified Capabilities
- `contract-inventory` (el camino de **alta**): pasa de INSERT crudo a alta dedup-aware con dual-write de activo.

## Approach

1. **Refactor sin cambio de comportamiento**: extraer la lógica de `dualWriteAsset` de `ConfirmInventorySuggestion` a un servicio/use case de application reutilizable. Verde con los tests existentes de `ConfirmInventorySuggestion` (red→green→refactor: el refactor no cambia comportamiento, los tests vigentes son la red de seguridad).
2. **Dedup + enrich + revive (TDD)**: nuevo use case de alta. Tests primero — in-memory repos:
   - alta de MAC nueva → crea CII + activo + movimiento INSTALL.
   - alta de MAC ya activa → enriquece (modelo), no duplica, devuelve el existente.
   - alta de MAC `removed` → revive a `active` + reconcilia el activo, no duplica.
   - sin SN (MAC-only, el router) → activo con serial sintetizado `CII-…`, dedup por MAC.
   - colisión de MAC instalada en OTRO contrato → `AssetInstalledElsewhereError` (no relocaliza a la fuerza).
3. **Wiring**: apuntar el POST `/contracts/:contractId/inventory` (y el alta del "Agregar por PPPoE") al nuevo use case. Pinear el wiring con un composition-root test (lección W6: el verify no ve el wiring de `app.ts`).
4. **Migración de limpieza**: `SELECT` de conteo → SQL hand-written guarded (mergear + dejar 1 por `(contractId, mac)`) → dry-run rolled-back vs prod → revisión del SQL con el usuario → recién ahí al deploy.
5. **FE**: el modal refleja enrich/revive; manejo del 200-existente.

## Affected Areas

| Área | Impacto | Descripción |
|------|---------|-------------|
| `src/application/use-cases/AddInstalledItemManually.ts` | Modified/Replaced | Alta dedup-aware + dual-write (o nuevo `AddContractEquipment` que lo reemplaza) |
| `src/application/services/matchInstalledItem.ts` | Modified | Permitir matchear contra `removed` (revive), precedencia activo > removed |
| `src/application/use-cases/ConfirmInventorySuggestion.ts` | Modified | Extraer `dualWriteAsset` al servicio compartido (sin cambio de comportamiento) |
| `src/application/services/InstallContractAsset.ts` (o use case) | New | Servicio compartido: crea/reusa activo + INSTALL (ex-`dualWriteAsset`) |
| `src/infrastructure/http/routes/contractInventory.routes.ts` | Modified | POST add apunta al nuevo use case (perm `inventory.write` intacto) |
| Composition root (`app.ts`) | Modified | Wiring del nuevo use case + DI de assets/movements/locations en el add |
| `prisma/migrations/<ts>_dedup_contract_equipment/migration.sql` | New | Limpieza hand-written guarded de duplicados existentes |
| `src/__tests__/...` | New | TDD: dedup/enrich/revive/MAC-only/colisión + composition-root test |
| `ipnext-frontend` (modal "Agregar por PPPoE") | Modified | UX "ya existe → completar/revivir"; maneja 200-existente |

## Risks

| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| La migración de limpieza borra la fila equivocada (pierde historial/aprobación) | Media | Hand-written + guard transaccional + conservar metadata más antigua + dry-run rolled-back + revisión del SQL con el usuario |
| Extraer `dualWriteAsset` rompe el flujo de sugerencias OCR/IClass | Media | Refactor puro cubierto por los tests existentes de `ConfirmInventorySuggestion`; review focalizada del diff |
| El 200-existente (enrich) rompe el FE que espera 201/fila nueva | Media | Contrato BE↔FE explícito; el FE maneja "completado"; test del seam |
| Revivir un `removed` reintroduce un equipo que de verdad se retiró | Baja | El revive solo dispara en el **add** explícito (el operador está agregando ese equipo); el destino real se gobierna en el Cambio B |
| MAC normalizada con falsos positivos al mergear duplicados | Baja | Misma normalización que `matchInstalledItem` (uppercase, sin `:`/`-`); el merge es por `(contractId, mac)`, no global |
| Colisión: MAC instalada en otro contrato | Baja | `AssetInstalledElsewhereError` ya existente → no relocaliza silenciosamente |

## Rollback

- Código: `git revert` del use case + wiring (el camino vuelve al INSERT crudo).
- Migración de limpieza: es transformación de datos → **no auto-reversible**; por eso el dry-run rolled-back + backup/`SELECT` previo de las filas afectadas antes de aplicar. El esquema NO cambia (no hay `ALTER`), así que el revert de código no deja drift.

## Dependencies

- Inventory Foundation (W1) ya en prod: `InventoryAsset`, `StockLocation`, `InventoryMovement`, `ResolveClientLocation`, ports de assets/movements. ✅ existe.
- `DeviceTypeCatalog` con `ROUTER`/`ANTENA` (o fallback `OTROS`) para resolver `deviceTypeId`. (verificar en el design).
- `matchInstalledItem` + `dualWriteAsset` existentes (se reusan/extraen).

## Success Criteria

- [ ] Alta por PPPoE de un equipo cuya MAC/SN ya existe → **no** crea fila nueva; enriquece (y revive si `removed`). Verificado en vivo (contrato 6290).
- [ ] Alta por PPPoE (MAC-only) con un equipo del **mismo tipo sin MAC** ya cargado (solo SN) → el modal ofrece **completar la MAC en el existente** (recomendado) en vez de duplicar; el operador confirma; nunca merge silencioso.
- [ ] Alta de equipo nuevo (antena **y** router, incl. MAC-only sin SN) → crea `ContractInstalledItem` **+** `InventoryAsset` `installed` en la `CLIENTE` location + movimiento `INSTALL`.
- [ ] La migración de limpieza deja **una** fila por `(contractId, mac)`; los duplicados de prod desaparecen (conteo post = 0). Dry-run rolled-back OK; SQL revisado con el usuario.
- [ ] Refactor de `dualWriteAsset` compartido **sin** cambio de comportamiento (tests de `ConfirmInventorySuggestion` verdes).
- [ ] Composition-root test pinea el wiring del nuevo use case en `app.ts`.
- [ ] `npm test` verde + `tsc --noEmit` limpio (BE) · `typecheck` + suite verde (FE).
- [ ] DIP preservado (el use case depende de ports, no de Prisma).
- [ ] Review adversarial CLEAN (foco: migración/merge · dual-write/concurrencia · contrato BE↔FE).
