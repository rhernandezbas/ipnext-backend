# contract-inventory-add Specification

## Purpose

Alta de equipos de un contrato (`ContractInstalledItem`) **dedup-aware** y con **activo trazable**: garantiza que no se creen filas duplicadas por la misma MAC/SN, completa/revive el equipo existente, materializa cada equipo como `InventoryAsset`, y limpia los duplicados ya existentes en prod. Cubre el "Agregar por PPPoE" y el "+ Agregar SN" manual (ambos detrás de `POST /api/contracts/:contractId/inventory`).

## Requirements

### Requirement: Dedup por identidad física (same_device → completar + revivir)

The system MUST NOT create a duplicate `ContractInstalledItem` when an item with the same MAC **or** SN already exists on the contract. It MUST enrich the existing item (fill only its null fields) and revive it if `removed`, returning the existing item with **200** (not a new row / 201).

#### Scenario: Alta cuya MAC ya existe en un item ACTIVO

- GIVEN un contrato con una ANTENA `active` MAC `78:8A:20:96:6A:AE`, `model` null
- WHEN POST /contracts/{id}/inventory con `{ type: "ANTENA", mac: "78:8a:20:96:6a:ae", model: "LiteBeam 5AC Gen2" }`
- THEN 200, NO se crea fila nueva; el item existente queda con `model = "LiteBeam 5AC Gen2"` (se completó el null), MAC intacta

#### Scenario: Alta cuya MAC coincide con un item REMOVED (revive)

- GIVEN un contrato con una ANTENA `removed` MAC `78:8A:...`
- WHEN POST /contracts/{id}/inventory con la misma MAC
- THEN 200, el item vuelve a `status: active`, se completan sus nulos; NO hay fila nueva ni un segundo activo

#### Scenario: La SN coincide aunque la MAC difiera

- GIVEN un item `active` con `serialNumber: "SN-001"`, `mac` null
- WHEN POST con `{ serialNumber: "sn001", mac: "AA:BB:..." }`
- THEN 200, match por SN normalizada (same_device); se completa la `mac`; NO duplica

#### Scenario: Enriquecer NO pisa datos existentes

- GIVEN un item con `model: "TP-Link Archer"`, MAC `c0:c9:...`
- WHEN POST con la misma MAC y `{ model: "Otro" }`
- THEN 200, `model` sigue siendo `"TP-Link Archer"` (solo se rellenan nulos)

---

### Requirement: Activo trazable en alta nueva (dual-write, incl. router y MAC-only)

The system MUST, when creating a new item (no match), also create/link an `InventoryAsset` (`status: installed`, en la `StockLocation` CLIENTE del contrato) and record an `INSTALL` movement, atomically. This applies to **every** device including routers and MAC-only devices (no SN).

#### Scenario: Alta de equipo nuevo con SN

- GIVEN un contrato sin ese equipo
- WHEN POST /contracts/{id}/inventory con `{ type: "ROUTER", serialNumber: "ABC123", mac: "c0:c9:...", model: "TP-Link" }`
- THEN 201; se crea el `ContractInstalledItem` con `assetId` no-null + un `InventoryAsset` `installed`@CLIENTE + un movimiento `INSTALL`

#### Scenario: Alta MAC-only (router/antena sin SN)

- GIVEN un equipo sin SN (el "Agregar por PPPoE" nunca trae SN)
- WHEN POST con `{ type: "ROUTER", mac: "c0:c9:e3:34:33:75" }` (sin `serialNumber`)
- THEN 201; el activo se crea con serial sintetizado `CII-{uuid}` y `mac` seteada; dedup posterior por esa MAC

#### Scenario: Atomicidad — si falla el movimiento, no queda item huérfano

- GIVEN el repo de movimientos falla dentro de la transacción
- WHEN POST de alta nueva
- THEN la transacción hace rollback: NO queda ni `ContractInstalledItem` ni `InventoryAsset` creados

#### Scenario: MAC instalada en OTRO contrato

- GIVEN un `InventoryAsset` con esa MAC `installed` en la CLIENTE location de OTRO contrato
- WHEN POST de alta con esa MAC en este contrato
- THEN error `AssetInstalledElsewhereError` (no se relocaliza silenciosamente)

---

### Requirement: Decisión de operador para same_type (sin identificador en común)

When no `same_device` match exists but an item of the same `type` exists on the contract (different/absent identity), the system MUST NOT create silently nor merge silently. It MUST return **409 `SAME_TYPE_NEEDS_DECISION`** with the candidate(s), unless the operator passes `completeItemId` (enrich that item) or `force: true` (create new).

#### Scenario: PPPoE trae MAC, ya hay una ANTENA solo-SN

- GIVEN un contrato con una ANTENA `active` `serialNumber: "SN-001"`, `mac` null
- WHEN POST con `{ type: "ANTENA", mac: "78:8A:..." }` (sin completeItemId/force)
- THEN 409 `SAME_TYPE_NEEDS_DECISION` con `candidates: [{ id, type: "ANTENA", serialNumber: "SN-001", mac: null }]`

#### Scenario: El operador elige completar el existente

- GIVEN el 409 anterior
- WHEN POST con `{ type: "ANTENA", mac: "78:8A:...", completeItemId: "<id de la ANTENA>" }`
- THEN 200; ese item queda con `mac: "78:8A:..."`; NO hay fila nueva

#### Scenario: El operador elige agregar como nuevo

- GIVEN el 409 anterior
- WHEN POST con `{ type: "ANTENA", mac: "78:8A:...", force: true }`
- THEN 201; se crea una ANTENA nueva (+ activo); ahora el contrato tiene dos ANTENAS

#### Scenario: same_device gana sobre force

- GIVEN un item con la misma MAC ya existe
- WHEN POST con esa MAC y `force: true`
- THEN 200 enriquece el existente (no duplica) — la identidad física manda sobre `force`

---

### Requirement: Limpieza de duplicados existentes (migración)

A data-transformation migration MUST collapse pre-existing duplicates by `(contractId, normalized MAC)` to a single row, merging missing fields into a deterministic keeper, and MUST abort (rollback) if any duplicate group survives.

#### Scenario: Contrato con MAC duplicada (caso real 6290)

- GIVEN dos filas misma MAC `78:8A:...` (una `removed` sin modelo, una `active` con `LiteBeam`)
- WHEN corre la migración
- THEN queda **una** fila para esa `(contractId, MAC)`; conserva el `active`; los nulos se completan; la otra se elimina

#### Scenario: Guard — un grupo no colapsa

- GIVEN (hipotético) un grupo que tras el merge sigue con >1 fila
- WHEN corre la migración
- THEN `RAISE EXCEPTION` → rollback total, prod intacto

#### Scenario: Idempotente / sin duplicados

- GIVEN una DB sin duplicados
- WHEN corre la migración
- THEN no cambia ninguna fila (no-op); el deploy sigue verde

## Invariants

- I-1: `src/application/use-cases/AddContractEquipment.ts` y `src/application/services/InstallContractAsset.ts` MUST NOT import from `@infrastructure/*`. Verifiable: `rg "from '@infrastructure" src/application/use-cases/AddContractEquipment.ts src/application/services/InstallContractAsset.ts` → 0.
- I-2: El alta de equipo (CII + asset + movement) MUST be atomic vía `UnitOfWork` cuando el dual-write está cableado. Verifiable: test de atomicidad (rollback).
- I-3: El DTO de item devuelto NO expone entidades Prisma crudas — mapea a `InstalledItemDto`. 
- I-4: `migration.sql` MUST NOT contain top-level `BEGIN;`/`COMMIT;` (gotcha 2026-06-10).

## Non-Regression

- NR-1: Los tests existentes de `ConfirmInventorySuggestion` / `ConfirmInventoryAtomicity` / `inventory.routes` / `inventory-composition-root` quedan **verdes sin modificarlos** (la extracción de `dualWriteAsset` no cambia comportamiento).
- NR-2: `tsc --noEmit` 0 errores; `npm test` 100% verde tras cada commit.
- NR-3: El permiso `inventory.write` de `POST /contracts/:id/inventory` queda intacto; los demás endpoints de inventario responden igual.
- NR-4: El camino de sugerencias de tarea (OCR/IClass) conserva su comportamiento (`matchInstalledItem` delega en `matchEquipment` sin cambiar su salida sobre activos).
