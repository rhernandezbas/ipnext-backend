# Design: "Agregar por PPPoE" sin duplicados + activo trazable (Cambio A)

## Contexto

El inventario de equipos de un contrato tiene HOY dos caminos de alta con comportamiento divergente:

- **Camino de sugerencias de tarea** (`ConfirmInventorySuggestion`): deduplica (`matchInstalledItem` → `same_device`/`same_type`), hace **dual-write** del `InventoryAsset` (`dualWriteAsset`) y todo corre **atómico** en una `UnitOfWork` (`runUnit` → `uow.runInTransaction`).
- **Camino de alta directa** (`AddInstalledItemManually`, detrás de `POST /contracts/:id/inventory`, que es el que usa "Agregar por PPPoE"): `INSERT` crudo, `assetId: null`, **sin dedup, sin activo, sin tx**.

El bug del usuario (contrato 6290, MAC duplicada) sale de ese segundo camino. **El fix es alinear el camino de alta directa con la maquinaria que el primero ya tiene** — no inventar.

### Piezas existentes que se reusan (verificadas file:line)

| Pieza | Ubicación | Qué da |
|------|-----------|--------|
| `matchInstalledItem` | `application/services/matchInstalledItem.ts:36-62` | `same_device` (MAC/SN normalizado) / `same_type` (mismo tipo). Hoy solo sobre activos. |
| `dualWriteAsset` | `ConfirmInventorySuggestion.ts:135-214` | crea/reusa `InventoryAsset` (`installed`@CLIENTE) + movimiento `INSTALL`; sintetiza serial `CII-${uuid}` para MAC-only (:160-165); dedup por serial-normalizado/MAC; `AssetInstalledElsewhereError` si está instalado en otro contrato. |
| `UnitOfWork` / `runInTransaction` | `domain/ports/UnitOfWork.ts`, `runUnit` `ConfirmInventorySuggestion.ts:341-348` | bag tx-scoped (`suggestions/inventory/locations/assets/movements`); `PrismaUnitOfWork` + `InMemoryUnitOfWork` ya existen. |
| `ResolveClientLocation` | `application/use-cases/ResolveClientLocation.ts` | resuelve/crea la `StockLocation` CLIENTE del contrato. |
| `nextStatus` | `domain/entities/inventory-asset.ts:68-74` | valida transición del activo (revive `removed→installed` ilegal → hay que pasar por `available`; ver Decisión 4). |

## Decisión 1 — Nuevo use case `AddContractEquipment` (reemplaza `AddInstalledItemManually`)

Un único use case dedup-aware detrás de `POST /contracts/:id/inventory`, consumido por **ambos** entrypoints (el "+ Agregar SN" manual y el alta del "Agregar por PPPoE"). Reemplaza a `AddInstalledItemManually` (se elimina; su comportamiento "siempre INSERT" era el bug).

**Constructor** (mismo patrón de deps opcionales que `ConfirmInventorySuggestion`, para que los tests in-memory sin ledger sigan andando):
```
AddContractEquipment(
  inventory: ContractInventoryRepository,
  catalog: DeviceTypeCatalogRepository,
  locations?, assets?, movements?, uow?,         // dual-write (W1) opcional
  install?: InstallContractAsset,                 // servicio compartido (Decisión 2)
)
```

**Input:**
```
{ contractId, type, serialNumber?, mac?, model?, notes?, addedByUserId?,
  completeItemId?,   // el operador eligió completar ESTE item (decisión same_type)
  force? }           // el operador eligió "agregar nuevo" pese al same_type
```

**Output:** `{ created: boolean, item: InstalledItemDto }` → la ruta mapea `created` a **201**, enrich a **200**.

### Flujo (orden de precedencia)

```
items = inventory.listByContract(contractId)            // ACTIVOS + REMOVED
m = matchEquipment({type, serialNumber, mac}, items)    // Decisión 3

1. m.status === 'same_device'  → ENRICH+REVIVE(m.item)         → { created:false }
2. completeItemId presente     → ENRICH+REVIVE(byId)           → { created:false }   (same_type confirmado por el operador)
3. m.status === 'same_type' && !force
                               → throw SameTypeNeedsDecisionError(candidatos)  → 409
4. else (force | sin candidato)→ CREATE + dual-write asset      → { created:true }
```

`same_device` SIEMPRE gana sobre `completeItemId`/`force` (si físicamente es el mismo equipo, no se duplica ni aunque el operador pida "nuevo").

## Decisión 2 — Extraer `dualWriteAsset` a un servicio compartido `InstallContractAsset`

`dualWriteAsset` es hoy un método privado de `ConfirmInventorySuggestion`. Se **extrae** a un servicio de `application/services/` que opera sobre el **bag tx-scoped** (`TransactionalRepos`), para que lo compartan `ConfirmInventorySuggestion` y `AddContractEquipment` sin duplicar lógica.

```
class InstallContractAsset {
  // recibe el bag tx-scoped (assets, movements, resolveClientLocation) + catalog
  installNew(b, { contractId, type, serialNumber, mac, source, sourceTaskId, taskId, technicianId }): Promise<string|null>
  reconcileForEnrich(b, { assetId, contractId, mac, type, source }): Promise<string|null>  // revive/instala el activo de un item enriquecido
}
```

- **Refactor sin cambio de comportamiento:** `ConfirmInventorySuggestion.dualWriteAsset` pasa a delegar en `install.installNew(b, …)`. Red de seguridad: los tests existentes (`ConfirmInventoryAtomicity.test.ts`, `inventory.routes.test.ts`, `inventory-composition-root.test.ts`) deben quedar **verdes sin tocarlos**.
- DIP: el servicio vive en `application`, depende de ports (assets/movements/locations/catalog), no de Prisma.

## Decisión 3 — `matchEquipment`: generalizar el match + incluir `removed`

`matchInstalledItem` toma una `TaskInventorySuggestion`; el alta directa no tiene suggestion. Se crea el núcleo puro **`matchEquipment(candidate, items)`** (candidate = `{type, serialNumber, mac}`) reusando los normalizadores existentes (`normalizeSerial`, `normMac`, `normSn`). `matchInstalledItem` se **refactoriza para delegar** en `matchEquipment` (adaptando la suggestion → candidate) — su path no cambia (sigue pasando solo activos).

**Precedencia (incluye removed para el revive):**
```
1. same_device sobre ACTIVOS    (mac o sn coincide)
2. same_device sobre REMOVED    (revive)
3. same_type  sobre ACTIVOS
4. same_type  sobre REMOVED
5. null
```
> `same_device` por **MAC o SN**: si comparten cualquiera de los dos, es el mismo equipo. El caso "existente solo-SN + PPPoE solo-MAC" NO comparte campo → cae a `same_type` (paso 3/4) → 409 → el operador decide en el modal (Cambio confirmado con el usuario: por MAC automático, mismo-tipo lo confirma el humano).

## Decisión 4 — Enrich + revive (y reconciliación del activo)

`ENRICH+REVIVE(item)` corre dentro de `runUnit` (atómico):

1. **Patch de campos faltantes** (COALESCE-style, NO pisa lo no-nulo): `model`, `serialNumber`, `mac`, `type` ← del input solo si el existente está en `null`.
2. **Revive:** si `item.status === 'removed'` → `status = 'active'`.
3. **Reconciliar el activo:**
   - Si `item.assetId` existe → cargar el activo. Llevarlo a `installed`@CLIENTE: como `removed→installed` es **ilegal** (`TRANSITIONS`), pasar `removed→available→installed` (o usar la ruta `available→installed`); registrar movimiento. Completar `asset.mac` si estaba null.
   - Si `item.assetId` es null (item legacy sin activo) → `install.installNew(b, …)` y estampar el `assetId` en el item. **Así el equipo enriquecido también queda trazable** (decisión del usuario: todo equipo es nuestro).
4. `inventory.update(item.id, patch)` con el `assetId` resuelto.

> **Edge:** si el activo (por MAC/serial) está `installed` en OTRO contrato → `AssetInstalledElsewhereError` (ya existe). No se relocaliza a la fuerza.

## Decisión 5 — `same_type` lo maneja el FE (operador-en-el-loop)

El BE expone la señal; el FE decide:

- El alta sin `completeItemId`/`force` que cae en `same_type` → **409 `SAME_TYPE_NEEDS_DECISION`** con `{ candidates: [{id, type, serialNumber, mac, model}] }`.
- El FE (modal de revisión del "Agregar por PPPoE") muestra: *"Ya hay una ANTENA (SN: X) sin MAC. ¿Es esta? → Completar su MAC [recomendado] · Agregar nuevo"*.
- "Completar" → re-POST con `completeItemId: X` → ENRICH. "Agregar nuevo" → re-POST con `force: true` → CREATE.
- **Nunca merge silencioso.** El 409 es esperado, no un error de sistema.

## Decisión 6 — Migración de limpieza de duplicados existentes

Transformación de datos → **SQL hand-written** (excepción justificada), idempotente y **transaccional** (sin `BEGIN/COMMIT` propios — `prisma migrate deploy` ya envuelve; gotcha 2026-06-10), con **guard**:

```sql
-- 1) (Observabilidad) RAISE NOTICE del conteo de grupos duplicados (visible en el log del deploy)
-- 2) Window: partition por (contractId, mac_normalizada NOT NULL), keeper = rn 1
--    orden: status='active' DESC, (assetId IS NOT NULL) DESC, createdAt ASC   (conserva activo + con-activo + aprobación más vieja)
-- 3) Merge: UPDATE keeper SET model=COALESCE(model, <loser>.model), serialNumber=COALESCE(...), mac=COALESCE(...) , ...
-- 4) Repoint: UPDATE "ContractInstalledItem" SET "replacesItemId"=keeper.id WHERE "replacesItemId" IN (losers)
-- 5) DELETE losers
-- 6) GUARD: si quedan grupos con count>1 → RAISE EXCEPTION (rollback total, prod intacto)
```

- Normalización de MAC idéntica a la app: `upper(regexp_replace(mac,'[:\-]','','g'))`.
- Solo grupos con `mac IS NOT NULL` (los dup por MAC = el bug real; el caso SN-only-dup es marginal y se nota aparte).
- **Segura aun con 0 duplicados** (no-op) → no necesita "correr el conteo antes": el `RAISE NOTICE` lo deja en el log del deploy.
- Se **revisa el SQL completo con el usuario** + **dry-run rolled-back vs prod** antes de pushear.

## Decisión 7 — Wiring y permisos

- `POST /contracts/:contractId/inventory` repunta a `AddContractEquipment` (perm `inventory.write` **intacto**). El payload suma `completeItemId?`/`force?` (zod, opcionales).
- En `app.ts`, el use case se instancia con las deps de W1 (`locations/assets/movements/uow/install`) ya disponibles (las usa `ConfirmInventorySuggestion`). **Composition-root test** que pinea que el add corre con dual-write (lección W6: el verify no ve el wiring).

## Riesgos y mitigaciones (resumen — detalle en proposal)

| Riesgo | Mitigación |
|--------|-----------|
| Refactor de `dualWriteAsset` rompe el confirm | tests existentes verdes sin tocar + review focalizada del diff |
| `removed→installed` ilegal en el state machine | revive vía `removed→available→installed` (Decisión 4) — test explícito |
| Migración borra la fila equivocada | keeper determinístico (window) + guard `RAISE EXCEPTION` + dry-run rolled-back + revisión con usuario |
| 409 same_type rompe el FE viejo | contrato explícito; el FE maneja el 409 como decisión, no error |

## Open questions (para apply)

1. ¿`UpdateInstalledItem` (PATCH existente) ya reconcilia el activo? Si el FE prefiere PATCH para "completar la MAC" en vez de re-POST con `completeItemId`, hay que decidir un solo punto que reconcilie el activo (no dos). **Recomendación:** un solo camino — el re-POST con `completeItemId` (el PATCH queda para edición pura sin tocar identidad/activo).
2. Confirmar que `DeviceTypeCatalog` tiene `ROUTER` y `ANTENA` (o el fallback `OTROS` cubre) para resolver `deviceTypeId` de los equipos PPPoE.
3. Keeper de la migración: ¿algún loser tiene `assetId` y el keeper no? Decidir si el keeper adopta ese `assetId` (merge) o se deja el activo del loser para higiene aparte (recomendado: dejar y notar).
