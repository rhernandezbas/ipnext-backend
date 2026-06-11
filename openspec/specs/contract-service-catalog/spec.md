# Service Catalog Specification

**Capability**: `contract-service-catalog` (NEW)
**Change**: `contract-services-model` (#43)
**Summary**: Editable catalog of contracted service types (INTERNET, TV, VOZ, CAMARAS, OTROS). Mirrors `DeviceTypeCatalog` exactly. ABM gated by `clients.manage`. OTROS is non-deletable. Delete guard returns 422 when catalog entry is in use by any `ContractService`.

---

## Requirements

### Requirement SC-1: List service catalog

The system MUST expose `GET /api/service-catalog` requiring `clients.read` permission.

#### Scenario SC-1.1: Returns all entries ordered by sortOrder

- GIVEN at least one `ServiceCatalog` entry exists
- WHEN `GET /api/service-catalog` is called with a valid `clients.read` token
- THEN the response MUST be HTTP 200 with array of `{ id, name, label, active, sortOrder, createdAt, updatedAt }` sorted by `sortOrder` ascending

#### Scenario SC-1.2: Filter active=true excludes inactive entries

- GIVEN entries INTERNET (active=true) and OTROS (active=false) exist
- WHEN `GET /api/service-catalog?active=true` is called
- THEN only INTERNET MUST be returned; OTROS MUST NOT appear

#### Scenario SC-1.3: 403 without clients.read

- GIVEN a token with no `clients.read` permission
- WHEN `GET /api/service-catalog` is called
- THEN the response MUST be HTTP 403

---

### Requirement SC-2: Create catalog entry

The system MUST expose `POST /api/service-catalog` requiring `clients.manage` permission.

#### Scenario SC-2.1: Successful creation

- GIVEN payload `{ name: "FIBRA", label: "Fibra óptica", sortOrder: 10 }` and a `clients.manage` token
- WHEN `POST /api/service-catalog` is called
- THEN the response MUST be HTTP 201 with the new entry including `id`, `active: true`

#### Scenario SC-2.2: 409 on duplicate name

- GIVEN a `ServiceCatalog` entry with `name = "INTERNET"` already exists
- WHEN `POST /api/service-catalog` with `{ name: "INTERNET" }` is called
- THEN the response MUST be HTTP 409 with `{ code: "SERVICE_CATALOG_NAME_CONFLICT" }`

#### Scenario SC-2.3: 403 without clients.manage

- GIVEN a token with only `clients.read`
- WHEN `POST /api/service-catalog` is called
- THEN the response MUST be HTTP 403

---

### Requirement SC-3: Update catalog entry

The system MUST expose `PATCH /api/service-catalog/:id` requiring `clients.manage`.

#### Scenario SC-3.1: Partial update succeeds

- GIVEN a `ServiceCatalog` entry with `id = X` exists
- WHEN `PATCH /api/service-catalog/X` with `{ label: "Internet hogar", active: false }` is called
- THEN the response MUST be HTTP 200 with updated entry reflecting new values

#### Scenario SC-3.2: 409 on name collision with another entry

- GIVEN entries A (`name="INTERNET"`) and B (`name="TV"`) both exist
- WHEN `PATCH /api/service-catalog/B.id` with `{ name: "INTERNET" }` is called
- THEN the response MUST be HTTP 409 with `{ code: "SERVICE_CATALOG_NAME_CONFLICT" }`

#### Scenario SC-3.3: 404 for non-existent id

- GIVEN no `ServiceCatalog` with `id = X` exists
- WHEN `PATCH /api/service-catalog/X` is called
- THEN the response MUST be HTTP 404 with `{ code: "SERVICE_CATALOG_NOT_FOUND" }`

---

### Requirement SC-4: Delete catalog entry

The system MUST expose `DELETE /api/service-catalog/:id` requiring `clients.manage`.

#### Scenario SC-4.1: Delete unused entry succeeds

- GIVEN a `ServiceCatalog` entry with `id = X` exists and no `ContractService` row references it
- WHEN `DELETE /api/service-catalog/X` is called with `clients.manage` token
- THEN the response MUST be HTTP 204 with no body

#### Scenario SC-4.2: 422 when entry is in use

- GIVEN a `ServiceCatalog` entry referenced by at least one `ContractService` row
- WHEN `DELETE /api/service-catalog/:id` is called
- THEN the response MUST be HTTP 422 with `{ code: "SERVICE_IN_USE" }`

#### Scenario SC-4.3: OTROS is non-deletable (422)

- GIVEN the seeded `ServiceCatalog` entry with `name = "OTROS"` exists
- WHEN `DELETE /api/service-catalog/:id` for that entry is called (even with 0 ContractService references)
- THEN the response MUST be HTTP 422 with `{ code: "SERVICE_CATALOG_NON_DELETABLE" }`

#### Scenario SC-4.4: 404 for non-existent id

- GIVEN no `ServiceCatalog` with `id = X` exists
- WHEN `DELETE /api/service-catalog/X` is called
- THEN the response MUST be HTTP 404 with `{ code: "SERVICE_CATALOG_NOT_FOUND" }`

---

### Requirement SC-5: Seed is idempotent

The system MUST seed `ServiceCatalog` via migration SQL using `ON CONFLICT (name) DO NOTHING`.

#### Scenario SC-5.1: Re-running seed does not create duplicates

- GIVEN seed SQL has been applied once (INTERNET, TV, VOZ, CAMARAS, OTROS present)
- WHEN the same seed SQL is applied again
- THEN the table MUST still contain exactly those 5 entries (no duplicates, no error)

#### Scenario SC-5.2: Seeded entries have expected names

- GIVEN a fresh database after migration
- WHEN `ServiceCatalog` table is queried
- THEN it MUST contain entries with names: `INTERNET`, `TV`, `VOZ`, `CAMARAS`, `OTROS`

---

## Constraints

- `name` MUST be unique; stored as provided (uppercase canonical recommended)
- `active` defaults to `true`; inactive entries MUST be excluded from `GET ?active=true` filter
- OTROS MUST be identified by `name = "OTROS"` for the non-deletable guard
- All endpoints MUST require authentication (`authMiddleware`) AND the stated permission (`requirePerm`)
- Use cases MUST depend on `ServiceCatalogRepository` port only — no direct Prisma imports
- DTOs MUST be returned; raw Prisma entities MUST NOT be returned from routes
- `InMemoryServiceCatalogRepository` MUST implement the full port for use-case tests

---

## Error Code Reference

| Scenario | HTTP | `code` |
|----------|------|--------|
| Not found | 404 | `SERVICE_CATALOG_NOT_FOUND` |
| Name conflict | 409 | `SERVICE_CATALOG_NAME_CONFLICT` |
| Entry in use by ContractService | 422 | `SERVICE_IN_USE` |
| OTROS non-deletable | 422 | `SERVICE_CATALOG_NON_DELETABLE` |
| No permission | 403 | (standard auth error) |
