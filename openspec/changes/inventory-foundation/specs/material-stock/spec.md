# MaterialStock Specification

## Purpose

Tracks the consumable quantity balance of a catalog material at a given stock location. Each `(materialCatalogId, locationId)` pair has exactly one `MaterialStock` row. Wave 1 scope: DEPOSITO locations at minimum.

## Requirements

### Requirement: Stock Balance Per Location

`MaterialStock` MUST have: `materialCatalogId → MaterialCatalog`, `locationId → StockLocation`, `qty` (float, ≥ 0). The combination `(materialCatalogId, locationId)` MUST be unique.

#### Scenario: stock record at depot

- GIVEN `MaterialCatalog` entry `M` and DEPOSITO location `L1`
- WHEN `MaterialStock` for `(M, L1)` is initialized with `qty=100`
- THEN a single record exists with `qty=100`

#### Scenario: unique constraint enforced

- GIVEN a `MaterialStock` record already exists for `(M, L1)`
- WHEN a second `MaterialStock` is created for the same `(M, L1)` pair
- THEN `DuplicateMaterialStockError` is thrown (or the operation performs an upsert)

---

### Requirement: Non-Negative Quantity Guard

`MaterialStock.qty` MUST NEVER go below zero. Any operation that would produce a negative balance MUST be rejected before any write occurs.

#### Scenario: decrement within balance succeeds

- GIVEN `MaterialStock(M, L1)` with `qty=10`
- WHEN a CONSUME movement decrements `qty` by `7`
- THEN `MaterialStock.qty` becomes `3`

#### Scenario: decrement below zero rejected

- GIVEN `MaterialStock(M, L1)` with `qty=5`
- WHEN a CONSUME movement attempts to decrement `qty` by `10`
- THEN `InsufficientStockError` is thrown and `qty` remains `5`

#### Scenario: qty exactly zero is valid

- GIVEN `MaterialStock(M, L1)` with `qty=5`
- WHEN a CONSUME movement decrements `qty` by `5`
- THEN `MaterialStock.qty` becomes `0` (no error)
