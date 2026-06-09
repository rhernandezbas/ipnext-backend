# InventoryBalance Derivation Specification

## Purpose

Defines the contract between the movement ledger and the materialized balances. The live truth lives in `InventoryAsset.currentLocationId` + `MaterialStock.qty`; the ledger is the immutable audit trail. This spec describes the invariants that MUST hold after any sequence of movements.

## Requirements

### Requirement: Materialized Balance as Live Truth

After every `RecordInventoryMovement` call, the materialized balances (`InventoryAsset.currentLocationId`, `InventoryAsset.status`, `MaterialStock.qty`) MUST reflect the net effect of all movements applied to date. The ledger is the audit record; the materialized fields are the queryable current state.

No read path (query use cases) SHALL compute balances from the ledger at read time. Balance is always read from the materialized fields.

#### Scenario: balance matches net of movements after a sequence

- GIVEN asset `A` starts at DEPOSITO `L_depot` (available)
- AND `RecordInventoryMovement(INSTALL, A → L_client, task T1)` is executed
- AND `RecordInventoryMovement(RETURN, A → L_depot)` is executed
- WHEN `GetAsset(A)` is called
- THEN `A.currentLocationId = L_depot` AND `A.status = available`
- AND 2 ledger rows exist for asset `A`

#### Scenario: material balance matches net of movements

- GIVEN `MaterialStock(M, L_depot)` initialized with `qty=50`
- AND `RecordInventoryMovement(CONSUME, M, qty=10, from L_depot)` is executed
- AND `RecordInventoryMovement(CONSUME, M, qty=5, from L_depot)` is executed
- WHEN `GetMaterialStock(M, L_depot)` is called
- THEN `qty = 35` (50 - 10 - 5)

---

### Requirement: Atomicity — Failed Movement Leaves Balances Untouched

If `RecordInventoryMovement` fails for ANY reason (validation, insufficient stock, FK violation, transaction error), BOTH the ledger row AND the materialized balance update MUST be rolled back. No partial write is permitted.

#### Scenario: failed CONSUME leaves balance unchanged

- GIVEN `MaterialStock(M, L_depot)` with `qty=5`
- WHEN `RecordInventoryMovement(CONSUME, M, qty=10, from L_depot)` is called (would go negative)
- THEN `InsufficientStockError` is thrown; `MaterialStock.qty` remains `5`; ledger has no new row

#### Scenario: failed INSTALL leaves asset location unchanged

- GIVEN asset `A` at `L_depot` with `status=available`, INSTALL attempted with invalid `taskId`
- WHEN `RecordInventoryMovement(INSTALL, A → L_client, taskId: 'nonexistent')` is called
- THEN the error is thrown; `A.currentLocationId` remains `L_depot`; `A.status` remains `available`; no ledger row added
