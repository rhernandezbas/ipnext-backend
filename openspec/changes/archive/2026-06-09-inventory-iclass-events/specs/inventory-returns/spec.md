# Inventory Returns Specification

## Purpose

Manages the lifecycle of equipment returns detected at RETIRO SO closure: staging pending return suggestions from OCR serials, and operator-confirmed RETURN→DEPOSITO movements.

---

## Requirements

### Requirement: Closure-Triggered Return Staging

When a RETIRO SO closes with a completed-removal result code, the system MUST stage one `ReturnSuggestion` per OCR-extracted serial on the associated task. The system MUST NOT mutate stock at staging time.

A completed-removal result code is defined as: `resultCodeType = 'Sucesso'` AND `description` in `{ "Retiro completo Servicio Fibra", "Retiro completo Servicio Wireless" }`.

For each serial: if `findBySerialNumber(serial)` resolves to an `InventoryAsset` with `status = 'installed'`, the suggestion MUST be staged with `status = 'pending'` and `matchedAssetId` set. Otherwise the suggestion MUST be staged with `status = 'needs_review'` and `matchedAssetId = null`.

After staging, the system MUST set `inventoryReturnsProcessed = true` on the SO.

#### Scenario: Completed retiro with matched serial

- GIVEN a RETIRO SO closed with result code "Retiro completo Servicio Fibra" (type Sucesso)
- AND the task has one OCR extraction with serial "SN-001" matching an installed InventoryAsset
- WHEN `StageReturnSuggestions` runs
- THEN one `ReturnSuggestion` is created with `status = 'pending'` and `matchedAssetId` set
- AND `inventoryReturnsProcessed` is set `true` on the SO
- AND no InventoryMovement is created

#### Scenario: Completed retiro with unmatched serial

- GIVEN a RETIRO SO closed with a completed-removal result code
- AND the task has one OCR serial "SN-UNKNOWN" that does not match any InventoryAsset
- WHEN `StageReturnSuggestions` runs
- THEN one `ReturnSuggestion` is created with `status = 'needs_review'` and `matchedAssetId = null`
- AND no InventoryMovement is created

#### Scenario: Serial matches an asset that is NOT installed

- GIVEN a RETIRO SO closed with a completed-removal result code
- AND the task has serial "SN-002" matching an InventoryAsset with `status = 'available'`
- WHEN `StageReturnSuggestions` runs
- THEN the suggestion is staged with `status = 'needs_review'` (asset not in installed state)
- AND no InventoryMovement is created

---

### Requirement: Non-Completed Retiro Stages Nothing

The system MUST NOT stage any `ReturnSuggestion` when a RETIRO SO closes with a result code that is NOT a completed-removal code (e.g., `resultCodeType = 'Pendente'` such as "Cliente Ausente").

#### Scenario: Retiro closed as "Cliente Ausente" (Pendente)

- GIVEN a RETIRO SO closed with result code "Cliente Ausente" (type Pendente)
- WHEN the closure side-effect pipeline runs
- THEN zero `ReturnSuggestion` records are created
- AND `inventoryReturnsProcessed` remains `false`

---

### Requirement: Staging Idempotency

The system MUST skip staging when `inventoryReturnsProcessed = true` on the SO, regardless of result code.

#### Scenario: Re-closure of an already-processed SO

- GIVEN a RETIRO SO with `inventoryReturnsProcessed = true`
- WHEN the closure side-effect pipeline runs again
- THEN zero new `ReturnSuggestion` records are created
- AND `inventoryReturnsProcessed` remains `true`

---

### Requirement: Confirm Matched Return

The system MUST allow an operator to confirm a `pending` (matched) `ReturnSuggestion`. On confirm, the system MUST execute `RecordInventoryMovement(RETURN, asset→DEPOSITO)` atomically via `UnitOfWork`. On success: `InventoryAsset.status` MUST become `'available'` at the depot location, and the suggestion `status` MUST become `'confirmed'`. The movement MUST carry a `sourceRef` keyed to the suggestion id to prevent double-return.

The operation MUST require the `inventory.manage` permission.

#### Scenario: Operator confirms a pending matched return

- GIVEN a `ReturnSuggestion` with `status = 'pending'` and a valid `matchedAssetId`
- WHEN `ConfirmAssetReturn` is called by an authorized operator
- THEN one `InventoryMovement` of type `RETURN` is persisted with `sourceRef = suggestion.id`
- AND the linked `InventoryAsset` has `status = 'available'` at the depot
- AND the suggestion `status` is `'confirmed'`

#### Scenario: Double-confirm is blocked by sourceRef

- GIVEN a `ReturnSuggestion` already `confirmed` with an existing movement carrying `sourceRef`
- WHEN `ConfirmAssetReturn` is called again for the same suggestion
- THEN no second `InventoryMovement` is created (unique constraint on `sourceRef` prevents duplication)

#### Scenario: Atomic rollback on movement failure

- GIVEN a `pending` suggestion and a transient failure during `RecordInventoryMovement`
- WHEN `ConfirmAssetReturn` runs inside `UnitOfWork`
- THEN neither the movement nor the asset status update is persisted (full rollback)
- AND the suggestion `status` remains `'pending'`

#### Scenario: Unauthorized confirm attempt

- GIVEN a caller without `inventory.manage` permission
- WHEN `ConfirmAssetReturn` is called
- THEN the request is rejected with a permission error
- AND no movement or status change occurs

---

### Requirement: No-Match Resolution

The system MUST allow an operator to resolve a `needs_review` suggestion via one of three actions: **create-at-depot**, **link-to-existing-asset**, or **discard**. The system MUST NOT auto-create or auto-link assets without operator action.

- **create-at-depot**: a new `InventoryAsset` is created at the depot with `status = 'available'`; the suggestion becomes `confirmed`.
- **link-to-existing-asset**: the operator selects an existing `InventoryAsset`; a `RETURN` movement is recorded for that asset (same atomicity/`sourceRef` rules as confirm-matched); suggestion becomes `confirmed`.
- **discard**: suggestion `status` becomes `'discarded'`; no movement.

#### Scenario: Operator creates asset at depot for unmatched serial

- GIVEN a `needs_review` suggestion with serial "SN-UNKNOWN"
- WHEN the operator chooses create-at-depot
- THEN a new `InventoryAsset` is persisted at the depot with `status = 'available'` and serial "SN-UNKNOWN"
- AND the suggestion becomes `'confirmed'`

#### Scenario: Operator links to an existing asset

- GIVEN a `needs_review` suggestion and the operator selects asset "ASSET-99"
- WHEN the operator confirms the link
- THEN a `RETURN` movement is recorded for "ASSET-99" with `sourceRef` = suggestion.id
- AND "ASSET-99" becomes `available` at depot
- AND the suggestion becomes `'confirmed'`

#### Scenario: Operator discards a needs_review suggestion

- GIVEN a `needs_review` suggestion
- WHEN the operator chooses discard
- THEN the suggestion `status` becomes `'discarded'`
- AND no `InventoryMovement` is created

---

### Requirement: Discard Pending Suggestion

The system MUST allow an operator to discard a `pending` suggestion (no movement needed).

#### Scenario: Operator discards a pending suggestion

- GIVEN a `ReturnSuggestion` with `status = 'pending'`
- WHEN the operator discards it
- THEN the suggestion `status` becomes `'discarded'`
- AND no `InventoryMovement` is created
