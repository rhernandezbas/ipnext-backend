# InventoryAsset Specification

## Purpose

Unified model for serialized physical equipment (ONUs, routers, antennas, etc.). Replaces `ContractInstalledItem` as the single source of truth for individual tracked devices. Every asset has an identity (serialNumber), a current location, and a lifecycle status.

## Requirements

### Requirement: Asset Creation

An `InventoryAsset` MUST have: `serialNumber` (unique, non-null), `mac` (optional), `deviceTypeId → DeviceTypeCatalog`, `status` (available|installed|removed|damaged|retired), `currentLocationId → StockLocation`, `source` (OCR|MANUAL|ICLASS), `sourceTaskId → ScheduledTask` (optional).

No two assets MAY share the same `serialNumber`. Attempting to create a duplicate MUST be rejected.

#### Scenario: create asset at depot (available)

- GIVEN a DEPOSITO location `L1` exists, `DeviceTypeCatalog` contains `'ROUTER'`
- WHEN `CreateInventoryAsset({ serialNumber: 'SN001', deviceTypeId: 'router-id', currentLocationId: 'L1', source: 'MANUAL', status: 'available' })` is called
- THEN an asset is created with `status=available`, `currentLocationId=L1`

#### Scenario: create asset at client location (installed)

- GIVEN a CLIENTE location `L2` for contract `C1` exists
- WHEN `CreateInventoryAsset({ serialNumber: 'SN002', deviceTypeId: 'onu-id', currentLocationId: 'L2', source: 'ICLASS', status: 'installed' })` is called
- THEN an asset is created with `status=installed`, `currentLocationId=L2`

#### Scenario: duplicate serialNumber rejected

- GIVEN an asset with `serialNumber='SN001'` already exists
- WHEN `CreateInventoryAsset({ serialNumber: 'SN001', ... })` is called
- THEN `DuplicateSerialNumberError` is thrown

#### Scenario: unknown deviceType rejected

- GIVEN `'UNKNOWN'` does not exist in `DeviceTypeCatalog`
- WHEN `CreateInventoryAsset({ deviceTypeId: 'unknown-id', ... })` is called
- THEN `UnknownDeviceTypeError` is thrown

---

### Requirement: Status Transitions

An `InventoryAsset.status` MUST follow valid transition rules:
- `available → installed` (via INSTALL movement)
- `installed → available` (via RETURN movement)
- `installed → removed` (via REMOVE event)
- `any → damaged | retired` (via ADJUST movement with explicit status)

Invalid transitions MUST be rejected.

#### Scenario: valid transition available→installed

- GIVEN asset `A` with `status=available`
- WHEN the asset's status is updated to `installed` (via a movement)
- THEN `status=installed` is persisted

#### Scenario: invalid transition available→removed rejected

- GIVEN asset `A` with `status=available`
- WHEN an attempt is made to set `status=removed` directly without an appropriate movement
- THEN `InvalidStatusTransitionError` is thrown

---

### Requirement: Serial Number Uniqueness Scope

`serialNumber` MUST be unique across ALL `InventoryAsset` records regardless of status or location. A retired or removed asset still holds its serial number.

#### Scenario: retired asset blocks reuse of serialNumber

- GIVEN asset `A` with `serialNumber='SN001'` and `status=retired`
- WHEN `CreateInventoryAsset({ serialNumber: 'SN001', ... })` is called
- THEN `DuplicateSerialNumberError` is thrown
