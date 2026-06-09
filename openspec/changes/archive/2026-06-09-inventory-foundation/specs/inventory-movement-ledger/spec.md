# InventoryMovement Ledger Specification

## Purpose

Immutable audit trail of every inventory event. Each movement record describes what moved, from where, to where, and why. The `RecordInventoryMovement` use case is the ONLY entry point for mutating inventory state — it records the ledger row AND updates the materialized balance atomically.

## Requirements

### Requirement: Movement Record Shape

An `InventoryMovement` MUST have: `type` (ISSUE|TRANSFER|INSTALL|RETURN|CONSUME|ADJUST), `source` (string), `occurredAt` (DateTime). It MUST have at least one of: `assetId → InventoryAsset` or `(materialCatalogId → MaterialCatalog, qty: float > 0)`. Optional: `fromLocationId → StockLocation`, `toLocationId → StockLocation`, `taskId → ScheduledTask`, `technicianId → RbacUser`, `note`.

Movement records MUST be immutable once created. No update or delete operation is permitted on `InventoryMovement`.

#### Scenario: ledger row immutability

- GIVEN movement `MV1` exists
- WHEN an attempt is made to update `MV1.note`
- THEN `MovementImmutableError` is thrown (or the operation is simply not available)

---

### Requirement: RecordInventoryMovement — INSTALL

An INSTALL movement MUST atomically: (1) create the ledger row, (2) set `asset.currentLocationId = toLocationId`, (3) set `asset.status = installed`.

INSTALL MUST require: `assetId`, `toLocationId` (a CLIENTE location), `taskId`.

#### Scenario: INSTALL moves asset depot→client

- GIVEN asset `A` at DEPOSITO `L_depot` with `status=available`, CLIENTE location `L_client`, task `T`
- WHEN `RecordInventoryMovement({ type: 'INSTALL', assetId: A, fromLocationId: L_depot, toLocationId: L_client, taskId: T })` is called
- THEN one `InventoryMovement` row exists; `A.currentLocationId = L_client`; `A.status = installed`

---

### Requirement: RecordInventoryMovement — RETURN

A RETURN movement MUST atomically: (1) create the ledger row, (2) set `asset.currentLocationId = toLocationId`, (3) set `asset.status = available`.

#### Scenario: RETURN moves asset client→depot

- GIVEN asset `A` at CLIENTE location `L_client` with `status=installed`
- WHEN `RecordInventoryMovement({ type: 'RETURN', assetId: A, fromLocationId: L_client, toLocationId: L_depot })` is called
- THEN one `InventoryMovement` row exists; `A.currentLocationId = L_depot`; `A.status = available`

---

### Requirement: RecordInventoryMovement — CONSUME

A CONSUME movement MUST atomically: (1) create the ledger row, (2) decrement `MaterialStock.qty` at `fromLocationId` by `qty`. If the resulting qty would be negative, the ENTIRE operation MUST be rejected (no partial write).

CONSUME MUST require: `materialCatalogId`, `qty > 0`, `fromLocationId`, `taskId`, `technicianId`.

#### Scenario: CONSUME decrements material stock

- GIVEN `MaterialStock(CABLE_COAXIAL, L_depot)` with `qty=20`, task `T`, technician `U`
- WHEN `RecordInventoryMovement({ type: 'CONSUME', materialCatalogId: cable-id, qty: 5, fromLocationId: L_depot, taskId: T, technicianId: U })` is called
- THEN `MaterialStock.qty = 15`; one ledger row exists

#### Scenario: CONSUME rejected when insufficient stock

- GIVEN `MaterialStock(CABLE_COAXIAL, L_depot)` with `qty=3`
- WHEN `RecordInventoryMovement({ type: 'CONSUME', qty: 10, ... })` is called
- THEN `InsufficientStockError` is thrown; `MaterialStock.qty` remains `3`; no ledger row created

---

### Requirement: RecordInventoryMovement — TRANSFER and ISSUE

A TRANSFER movement MUST move a material batch from one location to another atomically: decrement `fromLocation` stock, increment `toLocation` stock, create ledger row.

An ISSUE movement MUST decrement stock at `fromLocationId` without a `toLocationId` (stock leaves the system, e.g. given to a client outside a formal install).

#### Scenario: TRANSFER between locations

- GIVEN `MaterialStock(M, L1)` with `qty=50`, `MaterialStock(M, L2)` with `qty=0`
- WHEN `RecordInventoryMovement({ type: 'TRANSFER', materialCatalogId: M, qty: 10, fromLocationId: L1, toLocationId: L2 })` is called
- THEN `MaterialStock(M, L1).qty = 40`; `MaterialStock(M, L2).qty = 10`; one ledger row exists

---

### Requirement: RecordInventoryMovement — ADJUST

An ADJUST movement MUST directly set or correct a balance. For assets: sets `status` and/or `currentLocationId`. For materials: sets `MaterialStock.qty` to a given value. ADJUST MUST require a `note` explaining the correction.

#### Scenario: ADJUST corrects material quantity

- GIVEN `MaterialStock(M, L1)` with `qty=10`
- WHEN `RecordInventoryMovement({ type: 'ADJUST', materialCatalogId: M, qty: 15, toLocationId: L1, note: 'physical count correction' })` is called
- THEN `MaterialStock(M, L1).qty = 15`; one ledger row exists with `note` populated
