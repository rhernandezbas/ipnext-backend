# StockLocation Specification

## Purpose

Models physical or logical inventory locations in the system. Every serialized asset and material stock balance is anchored to a `StockLocation`. Three types exist: `DEPOSITO` (warehouse singleton), `CLIENTE` (per-contract), `TECNICO` (per-technician).

## Requirements

### Requirement: Location Types and Typed FKs

A `StockLocation` MUST have a `type` of `DEPOSITO`, `CLIENTE`, or `TECNICO`. Each type carries a typed nullable FK:
- `CLIENTE` MUST have `contractId → Contract` (non-null for this type).
- `TECNICO` MUST have `technicianId → RbacUser` (non-null for this type).
- `DEPOSITO` MUST have both FKs null; identified by a unique `name`.

Any combination that violates these constraints MUST be rejected at the domain layer.

#### Scenario: create DEPOSITO location

- GIVEN no location with `name='DEPOSITO_CENTRAL'` exists
- WHEN `CreateStockLocation({ type: 'DEPOSITO', name: 'DEPOSITO_CENTRAL' })` is called
- THEN a location is created with `type=DEPOSITO`, `contractId=null`, `technicianId=null`

#### Scenario: create CLIENTE location

- GIVEN a Contract with id `C1` exists
- WHEN `CreateStockLocation({ type: 'CLIENTE', contractId: 'C1' })` is called
- THEN a location is created with `type=CLIENTE`, `contractId='C1'`, `technicianId=null`

#### Scenario: create TECNICO location

- GIVEN an RbacUser (technician) with id `U1` exists
- WHEN `CreateStockLocation({ type: 'TECNICO', technicianId: 'U1' })` is called
- THEN a location is created with `type=TECNICO`, `technicianId='U1'`, `contractId=null`

#### Scenario: invalid type rejected

- GIVEN no precondition
- WHEN `CreateStockLocation({ type: 'CAMIONETA' })` is called
- THEN `InvalidLocationTypeError` is thrown

#### Scenario: CLIENTE without contractId rejected

- GIVEN no precondition
- WHEN `CreateStockLocation({ type: 'CLIENTE', contractId: null })` is called
- THEN `MissingLocationFkError` is thrown

---

### Requirement: DEPOSITO Singleton Resolution

The system MUST provide a `ResolveDepotLocation` operation that returns the named DEPOSITO singleton. If it does not exist, the operation MUST create it (idempotent upsert).

#### Scenario: depot already exists

- GIVEN a DEPOSITO location `name='DEPOSITO_CENTRAL'` exists
- WHEN `ResolveDepotLocation('DEPOSITO_CENTRAL')` is called
- THEN the same location id is returned; no duplicate is created

#### Scenario: depot does not exist yet

- GIVEN no DEPOSITO location exists
- WHEN `ResolveDepotLocation('DEPOSITO_CENTRAL')` is called
- THEN a new DEPOSITO location is created and its id is returned

---

### Requirement: Per-Contract CLIENTE Location Resolution

The system MUST provide a `ResolveClientLocation(contractId)` operation that returns or creates the CLIENTE location for that contract (idempotent).

#### Scenario: resolve existing client location

- GIVEN a CLIENTE location for contract `C1` already exists
- WHEN `ResolveClientLocation('C1')` is called
- THEN the existing location id is returned; no duplicate is created

#### Scenario: CLIENTE location is unique per contract

- GIVEN CLIENTE locations exist for contracts `C1` and `C2`
- WHEN `GetLocationByContract('C1')` is called
- THEN only the location for `C1` is returned
