# Contract Services Specification

**Capability**: `contract-services` (NEW)
**Change**: `contract-services-model` (#43)
**Summary**: Pivot `ContractService` linking contracts to catalog entries. CRUD on `/api/contracts/:contractId/services`. `GET /api/clients/:id/contracts` is additive — includes `services[]` eager, existing shape untouched.

---

## Requirements

### Requirement CSV-1: Add service to contract

The system MUST expose `POST /api/contracts/:contractId/services` requiring `clients.write`.

#### Scenario CSV-1.1: Successful add

- GIVEN contract `contractId = C` exists and `ServiceCatalog` entry `serviceCatalogId = S` is active
- WHEN `POST /api/contracts/C/services` with `{ serviceCatalogId: S, notes: "principal" }` and a `clients.write` token
- THEN the response MUST be HTTP 201 with `{ id, contractId, serviceCatalogId, name, label, status: "active", notes, createdAt }`

#### Scenario CSV-1.2: 409 on duplicate

- GIVEN `ContractService` with `(contractId=C, serviceCatalogId=S)` already exists
- WHEN `POST /api/contracts/C/services` with same `serviceCatalogId = S` is called
- THEN the response MUST be HTTP 409 with `{ code: "CONTRACT_SERVICE_DUPLICATE" }`

#### Scenario CSV-1.3: 422 when catalog entry is inactive

- GIVEN `ServiceCatalog` entry `S` has `active = false`
- WHEN `POST /api/contracts/C/services` with `{ serviceCatalogId: S }` is called
- THEN the response MUST be HTTP 422 with `{ code: "SERVICE_CATALOG_INACTIVE" }`

#### Scenario CSV-1.4: 404 when contract not found

- GIVEN no contract with `contractId = X` exists
- WHEN `POST /api/contracts/X/services` is called
- THEN the response MUST be HTTP 404 with `{ code: "CONTRACT_NOT_FOUND" }`

#### Scenario CSV-1.5: 404 when catalog entry not found

- GIVEN `serviceCatalogId = 999` does not exist in `ServiceCatalog`
- WHEN `POST /api/contracts/C/services` with `{ serviceCatalogId: 999 }` is called
- THEN the response MUST be HTTP 404 with `{ code: "SERVICE_CATALOG_NOT_FOUND" }`

#### Scenario CSV-1.6: 403 without clients.write

- GIVEN a token with only `clients.read`
- WHEN `POST /api/contracts/C/services` is called
- THEN the response MUST be HTTP 403

---

### Requirement CSV-2: Update contract service

The system MUST expose `PATCH /api/contracts/:contractId/services/:id` requiring `clients.write`.

#### Scenario CSV-2.1: Update status to inactive

- GIVEN `ContractService` with `id = CS` and `status = "active"` exists
- WHEN `PATCH /api/contracts/C/services/CS` with `{ status: "inactive" }` is called
- THEN the response MUST be HTTP 200 with `status: "inactive"` in the response body

#### Scenario CSV-2.2: Update notes only

- GIVEN `ContractService` with `id = CS` exists
- WHEN `PATCH /api/contracts/C/services/CS` with `{ notes: "secundario" }` is called
- THEN the response MUST be HTTP 200 with updated `notes` field

#### Scenario CSV-2.3: Reactivating inactive service succeeds (not a duplicate)

- GIVEN `ContractService` CS has `status = "inactive"` for `(contractId=C, serviceCatalogId=S)`
- WHEN `PATCH /api/contracts/C/services/CS` with `{ status: "active" }` is called
- THEN the response MUST be HTTP 200 with `status: "active"`
- AND a new `POST` for same `(C, S)` MUST still return 409 (UNIQUE constraint covers all statuses)

#### Scenario CSV-2.4: 404 when service not found

- GIVEN no `ContractService` with `id = X` exists
- WHEN `PATCH /api/contracts/C/services/X` is called
- THEN the response MUST be HTTP 404 with `{ code: "CONTRACT_SERVICE_NOT_FOUND" }`

---

### Requirement CSV-3: Remove service from contract

The system MUST expose `DELETE /api/contracts/:contractId/services/:id` requiring `clients.write`.

#### Scenario CSV-3.1: Delete existing service returns 204

- GIVEN `ContractService` with `id = CS` exists
- WHEN `DELETE /api/contracts/C/services/CS` is called with `clients.write` token
- THEN the response MUST be HTTP 204 with no body

#### Scenario CSV-3.2: Delete non-existent service is idempotent (204)

- GIVEN no `ContractService` with `id = X` exists
- WHEN `DELETE /api/contracts/C/services/X` is called
- THEN the response MUST be HTTP 204 (idempotent — no error)

---

### Requirement CSV-4: Client contracts response includes services (additive)

The system MUST include `services[]` in `GET /api/clients/:id/contracts` without breaking existing response shape.

#### Scenario CSV-4.1: Contract with services returns populated array

- GIVEN contract C has two `ContractService` entries (INTERNET, TV)
- WHEN `GET /api/clients/:id/contracts` is called
- THEN each contract object MUST include `services: [{ id, serviceCatalogId, name, label, status, notes, createdAt }]`
- AND existing fields (`id, type, plan, status, startDate, endDate, ip, address, lat, lng, technology, name`) MUST be present and unchanged

#### Scenario CSV-4.2: Contract with zero services returns empty array (not null)

- GIVEN contract C has no `ContractService` entries
- WHEN `GET /api/clients/:id/contracts` is called
- THEN that contract's `services` field MUST be `[]` (empty array, not `null` or `undefined`)

#### Scenario CSV-4.3: Regression — existing shape fields are untouched

- GIVEN a contract exists with `plan = "FIBRA 100MB"`, `status = "active"`, `technology = "Fiber"`
- WHEN `GET /api/clients/:id/contracts` is called
- THEN the response MUST contain those fields with their original values
- AND no previously-present field MUST be missing or renamed

#### Scenario CSV-4.4: No N+1 — services fetched via eager include

- GIVEN a client with 5 contracts each having services
- WHEN `GET /api/clients/:id/contracts` is called
- THEN the implementation MUST use a single query (Prisma `include: { contractServices: { include: { serviceCatalog: true } } }`) — NOT one query per contract

---

## Constraints

- `ContractService` UNIQUE constraint on `(contractId, serviceCatalogId)` covers all statuses — re-posting an inactive service MUST 409
- `status` field MUST be `"active" | "inactive"` (string enum, default `"active"`)
- `notes` is optional (`String?`)
- Services response shape per item: `{ id, serviceCatalogId, name, label, status, notes, createdAt }` — `name` and `label` sourced from joined `ServiceCatalog`
- All endpoints MUST require authentication AND the stated permission (two-layer guard)
- Use cases MUST depend on port interfaces only; no direct Prisma imports
- `InMemoryContractServiceRepository` MUST implement full port for use-case tests

---

## Error Code Reference

| Scenario | HTTP | `code` |
|----------|------|--------|
| Duplicate (C, S) pair | 409 | `CONTRACT_SERVICE_DUPLICATE` |
| Catalog entry inactive | 422 | `SERVICE_CATALOG_INACTIVE` |
| Contract not found | 404 | `CONTRACT_NOT_FOUND` |
| Catalog entry not found | 404 | `SERVICE_CATALOG_NOT_FOUND` |
| ContractService not found | 404 | `CONTRACT_SERVICE_NOT_FOUND` |
| No permission | 403 | (standard auth error) |
