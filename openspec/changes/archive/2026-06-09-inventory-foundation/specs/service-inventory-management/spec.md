# Delta for service-inventory-management

## MODIFIED Requirements

### Requirement: ConfirmInventorySuggestion branches by `kind`

`ConfirmInventorySuggestion` MUST branch on `suggestion.kind`:
- `'DEVICE'` → creates/updates a `ContractInstalledItem` AND MUST additionally: (a) create an `InventoryAsset` at the contract's CLIENTE location (idempotent by `serialNumber` — upsert if SN already exists), (b) record an INSTALL `InventoryMovement` linking `taskId`, `technicianId`, and the asset. The `ContractInstalledItem` row MUST continue to exist and be queryable as before (operator UX is unchanged).
- `'MATERIAL'` → creates a `TaskMaterialConsumption` (preserving `materialDesc` as `materialName`, `quantity`, `unit`); resolves the catalog entry by `materialDesc` using `upsert`. (No change from existing behavior for the MATERIAL branch.)

(Previously: DEVICE branch only created/updated `ContractInstalledItem`; no `InventoryAsset` or ledger write was performed.)

#### Scenario: confirm MATERIAL suggestion (unchanged)

- GIVEN `TaskInventorySuggestion` with `kind='MATERIAL'`, `materialDesc='CABLE COAXIAL'`, `quantity=5`, `unit='m'`, linked to task `T` with `contractId`
- WHEN `ConfirmInventorySuggestion({ suggestionId })`
- THEN a `TaskMaterialConsumption` row exists for task `T` with `materialName='CABLE COAXIAL'`, `quantity=5`, `unit='m'` and `MaterialCatalog` contains `'CABLE COAXIAL'` (created if absent)

#### Scenario: confirm DEVICE suggestion → asset + movement + CII created

- GIVEN `TaskInventorySuggestion` with `kind='DEVICE'`, `deviceType='ROUTER'`, `serialNumber='SN123'`, task `T` with `contractId='C1'`
- AND a CLIENTE `StockLocation` for contract `C1` exists (or is resolved)
- WHEN `ConfirmInventorySuggestion({ suggestionId })`
- THEN a `ContractInstalledItem` is created for contract `C1` (existing behavior preserved)
- AND an `InventoryAsset` with `serialNumber='SN123'`, `status=installed`, `currentLocationId = CLIENTE(C1)` exists
- AND one `InventoryMovement` of type `INSTALL` exists referencing the asset and task `T`

#### Scenario: confirm DEVICE suggestion — CII still queryable

- GIVEN `ConfirmInventorySuggestion` was called for a DEVICE suggestion on contract `C1`
- WHEN `ListContractInstalledItems({ contractId: 'C1' })` is called
- THEN the device appears in the list with its `serialNumber`, `type`, and `status='active'`

#### Scenario: confirm MATERIAL suggestion — no asset or movement created

- GIVEN `TaskInventorySuggestion` with `kind='MATERIAL'`
- WHEN `ConfirmInventorySuggestion({ suggestionId })`
- THEN no `InventoryAsset` is created; no `InventoryMovement` is created

#### Scenario: confirm MATERIAL suggestion — TaskHasNoContractError (unchanged)

- GIVEN `TaskInventorySuggestion` with `kind='MATERIAL'` linked to task `T` where `task.contractId` is null
- WHEN `ConfirmInventorySuggestion({ suggestionId })`
- THEN `TaskHasNoContractError` is thrown
