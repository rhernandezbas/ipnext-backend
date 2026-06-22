# contract-inventory-retire Specification

## Purpose

Retiro de un equipo de un contrato **con destino obligatorio**: el operador elige a dónde va el equipo (Depósito / Con técnico / Se lo queda el cliente / Dañado / Baja definitiva) y el sistema rutea el `InventoryAsset` vinculado a la `StockLocation` + estado correctos y registra el movimiento en el ledger — trazabilidad completa del retiro.

## Requirements

### Requirement: Retiro con destino — ruteo del activo por disposition

The system MUST, on `POST /api/contracts/:contractId/inventory/:itemId/retire` with a valid `disposition`, soft-delete the `ContractInstalledItem` (status='removed') AND route the linked `InventoryAsset` to the correct status/location with a recorded `InventoryMovement`, all atomically. The asset enters `installed` at the contract's CLIENTE location.

#### Scenario: Depósito

- GIVEN un item `active` con activo `installed`@CLIENTE
- WHEN POST .../retire `{ disposition: "DEPOSITO" }`
- THEN 200; item `removed`; activo `available` en DEPOSITO; movimiento `RETURN` (from CLIENTE → to DEPOSITO)

#### Scenario: Con técnico

- GIVEN un item `active` con activo `installed`@CLIENTE y un técnico `t1`
- WHEN POST .../retire `{ disposition: "TECNICO", technicianId: "t1" }`
- THEN 200; activo `available` en la location TECNICO de `t1`; movimiento `TRANSFER` (CLIENTE → TECNICO) con `technicianId="t1"`

#### Scenario: Se lo queda el cliente

- GIVEN un item `active` con activo `installed`@CLIENTE
- WHEN POST .../retire `{ disposition: "CLIENTE" }`
- THEN 200; activo `retired`, sigue en la location CLIENTE; movimiento `ADJUST` (status=retired)

#### Scenario: Dañado

- WHEN POST .../retire `{ disposition: "DAMAGED" }`
- THEN 200; activo `damaged` en DEPOSITO; movimiento `ADJUST` (status=damaged)

#### Scenario: Baja definitiva

- WHEN POST .../retire `{ disposition: "RETIRED" }`
- THEN 200; activo `retired` en DEPOSITO; movimiento `ADJUST` (status=retired)

#### Scenario: Nota opcional

- WHEN POST .../retire `{ disposition: "DEPOSITO", note: "se cambió por upgrade" }`
- THEN el movimiento registrado tiene `note = "se cambió por upgrade"`

---

### Requirement: Validación del destino

The system MUST require a valid `disposition`, and MUST require `technicianId` when (and only when) `disposition === 'TECNICO'`.

#### Scenario: disposition faltante o inválida

- WHEN POST .../retire `{}` o `{ disposition: "XX" }`
- THEN 400 (zod)

#### Scenario: TECNICO sin technicianId

- WHEN POST .../retire `{ disposition: "TECNICO" }` (sin technicianId)
- THEN 400 (refine zod / TechnicianRequiredError)

---

### Requirement: Casos borde — scoping, idempotencia, legacy

#### Scenario: Item de otro contrato

- GIVEN un item bajo el contrato B
- WHEN POST /contracts/A/inventory/:itemB/retire
- THEN 404 (no pertenece a A)

#### Scenario: Item ya removido (idempotente)

- GIVEN un item `removed`
- WHEN POST .../retire `{ disposition: "DEPOSITO" }`
- THEN devuelve el item sin re-rutear el activo (no-op, no doble movimiento)

#### Scenario: Item legacy sin activo

- GIVEN un item `active` con `assetId = null`
- WHEN POST .../retire `{ disposition: "DEPOSITO" }`
- THEN 200; item `removed`; NO se intenta rutear activo (no crash, no movimiento)

#### Scenario: Atomicidad

- GIVEN el repo de movimientos falla dentro de la tx
- WHEN POST .../retire
- THEN rollback: el item NO queda `removed` y el activo NO cambia de estado/ubicación

## Invariants

- I-1: `RetireInstalledItem.ts` y `RouteAssetToDisposition.ts` MUST NOT import `@infrastructure/*`. Verifiable: `rg` → 0.
- I-2: El retiro (CII removed + transición de activo + movimiento) MUST be atomic vía `UnitOfWork`.
- I-3: Todas las transiciones de estado salen de `installed` y son legales (`nextStatus`); no se fuerza ninguna ilegal.

## Non-Regression

- NR-1: El `RemoveInstalledItem`/DELETE viejo sigue funcionando (no se borra); sus tests verdes.
- NR-2: `tsc --noEmit` 0 + `npm test` 100% verde tras cada commit.
- NR-3: `inventory.write` en el endpoint nuevo; los demás endpoints de inventario sin cambios.
- NR-4: `GET /inventory/technicians` (el picker) sin cambios de contrato.
