# Spec: service-technology-catalog

## Overview

An editable catalog of service technology types (e.g., Fiber, DOCSIS, Wireless) with a unique name and optional description. Mirrors `TaskCategory` exactly. `Service.technology` stores the technology name as a free string; the catalog drives the UI dropdown. No FK relation in Phase 1.

## ADDED Requirements

### Requirement ST-1: List service technologies

**Priority**: MUST

#### Scenario ST-1.1: List returns all technologies ordered by name

- Given at least one `ServiceTechnology` exists in the catalog
- When `GET /api/service-technologies` is called with a valid auth token
- Then the response MUST be HTTP 200 with an array of `ServiceTechnologyDTO` sorted by `name` ascending

#### Scenario ST-1.2: List returns empty array when catalog is empty

- Given no `ServiceTechnology` records exist
- When `GET /api/service-technologies` is called with a valid auth token
- Then the response MUST be HTTP 200 with an empty array `[]`

#### Scenario ST-1.3: Unauthenticated request is rejected

- Given no auth token is provided
- When `GET /api/service-technologies` is called
- Then the response MUST be HTTP 401

---

### Requirement ST-2: Get single service technology by id

**Priority**: MUST

#### Scenario ST-2.1: Found by id

- Given a `ServiceTechnology` with `id = X` exists
- When `GET /api/service-technologies/:id` is called with `id = X` and a valid auth token
- Then the response MUST be HTTP 200 with the matching `ServiceTechnologyDTO`

#### Scenario ST-2.2: Not found returns 404

- Given no `ServiceTechnology` with `id = X` exists
- When `GET /api/service-technologies/:id` is called with `id = X` and a valid auth token
- Then the response MUST be HTTP 404 with `{ error: string, code: "SERVICE_TECHNOLOGY_NOT_FOUND" }`

---

### Requirement ST-3: Create service technology

**Priority**: MUST

#### Scenario ST-3.1: Successful creation

- Given a valid payload `{ name: "Fiber", description: "Optical fiber" }`
- When `POST /api/service-technologies` is called with a valid auth token
- Then the response MUST be HTTP 201 with the new `ServiceTechnologyDTO` (id, name, description, createdAt, updatedAt)

#### Scenario ST-3.2: Name conflict returns 409

- Given a `ServiceTechnology` with `name = "Fiber"` already exists
- When `POST /api/service-technologies` with `{ name: "FIBER" }` is called (case-insensitive check)
- Then the response MUST be HTTP 409 with `{ error: string, code: "SERVICE_TECHNOLOGY_NAME_CONFLICT" }`

#### Scenario ST-3.3: Missing required field returns 400

- Given a payload missing the required `name` field
- When `POST /api/service-technologies` is called with a valid auth token
- Then the response MUST be HTTP 400 with `{ error: "Validation error", code: "VALIDATION_ERROR", details: [...] }`

---

### Requirement ST-4: Update service technology

**Priority**: MUST

#### Scenario ST-4.1: Partial update succeeds

- Given a `ServiceTechnology` with `id = X` exists
- When `PUT /api/service-technologies/:id` is called with `{ description: "Updated" }` and a valid auth token
- Then the response MUST be HTTP 200 with the updated `ServiceTechnologyDTO`

#### Scenario ST-4.2: Name update with conflict returns 409

- Given `ServiceTechnology` A with `name = "Fiber"` and B with `name = "DOCSIS"` both exist
- When `PUT /api/service-technologies/A.id` is called with `{ name: "docsis" }` (case-insensitive)
- Then the response MUST be HTTP 409 with `{ code: "SERVICE_TECHNOLOGY_NAME_CONFLICT" }`

#### Scenario ST-4.3: Update non-existent record returns 404

- Given no `ServiceTechnology` with `id = X` exists
- When `PUT /api/service-technologies/:id` is called with a valid auth token
- Then the response MUST be HTTP 404 with `{ code: "SERVICE_TECHNOLOGY_NOT_FOUND" }`

---

### Requirement ST-5: Delete service technology

**Priority**: MUST

#### Scenario ST-5.1: Delete unused technology succeeds

- Given a `ServiceTechnology` with `id = X` exists and no `Service` row has `technology = X.name`
- When `DELETE /api/service-technologies/:id` is called with a valid auth token
- Then the response MUST be HTTP 204 with no body

#### Scenario ST-5.2: Delete technology in use returns 409

- Given a `ServiceTechnology` with `name = "Fiber"` exists
- And at least one `Service` row has `technology = "Fiber"`
- When `DELETE /api/service-technologies/:id` is called with a valid auth token
- Then the response MUST be HTTP 409 with `{ code: "SERVICE_TECHNOLOGY_IN_USE" }`

#### Scenario ST-5.3: Delete non-existent record returns 404

- Given no `ServiceTechnology` with `id = X` exists
- When `DELETE /api/service-technologies/:id` is called with a valid auth token
- Then the response MUST be HTTP 404 with `{ code: "SERVICE_TECHNOLOGY_NOT_FOUND" }`

---

### Requirement ST-6: Seed canonical values

**Priority**: SHOULD

#### Scenario ST-6.1: Canonical values present after seed

- Given `npm run prisma:seed` is executed on a fresh database
- When the `ServiceTechnology` table is queried
- Then it MUST contain at least the following entries: Fiber, DOCSIS, Wireless, FTTH, HFC, Radio

---

## ADDED Requirements (service-technology-assignment)

### Requirement ST-7: Service model has nullable technology column

**Priority**: MUST

#### Scenario ST-7.1: Additive migration does not break existing Service rows

- Given existing `Service` rows in the database
- When the migration adding `technology String?` to `Service` is applied
- Then all existing rows MUST remain with `technology = NULL` and no data loss occurs

#### Scenario ST-7.2: GR sync does not overwrite technology

- Given a `Service` row with `technology = "Fiber"`
- When `PrismaClientMirrorRepository.upsertContract` runs (GR sync)
- Then the `technology` column MUST remain unchanged (not overwritten to NULL or any other value)

## ADDED Requirements (services-listing)

### Requirement SV-1: Global paginated services (contracts) listing

**Priority**: MUST

The contracts page in the frontend consumes `GET /api/services` to render a global, paginated list of all services across all clients, with optional filters. The response envelope and item shape MUST match the frontend `PaginatedResponse<ContractSummary>` contract exactly.

#### Scenario SV-1.1: List returns paginated envelope

- Given one or more `Service` rows exist
- When `GET /api/services` is called with a valid auth token
- Then the response MUST be HTTP 200 with `{ data: ContractSummary[], total: number, page: number, pageSize: number, totalPages: number }`
- And each `ContractSummary` MUST have exactly `{ id: string, clientName: string, plan: string, status: string, technology: string | null, startDate: string }`

#### Scenario SV-1.2: Empty result returns empty envelope

- Given no `Service` rows match the query
- When `GET /api/services` is called with a valid auth token
- Then the response MUST be HTTP 200 with `{ data: [], total: 0, page: 1, pageSize: 25, totalPages: 1 }`

#### Scenario SV-1.3: Filter by status (exact match)

- Given services with different `status` values exist
- When `GET /api/services?status=blocked` is called
- Then only services with `status = "blocked"` MUST be returned

#### Scenario SV-1.4: Filter by technology (exact match)

- Given services with different `technology` values exist
- When `GET /api/services?technology=Wireless` is called
- Then only services with `technology = "Wireless"` MUST be returned

#### Scenario SV-1.5: Search by plan or client name (case-insensitive)

- Given services with varied plans and client names exist
- When `GET /api/services?search=juan` is called
- Then only services whose `plan` OR owning client `name` contains the term (case-insensitive) MUST be returned

#### Scenario SV-1.6: Pagination via page and limit

- Given 5 services exist
- When `GET /api/services?page=2&limit=2` is called
- Then the response MUST have `page = 2`, `pageSize = 2`, `total = 5`, `totalPages = 3`, and `data` of length 2

#### Scenario SV-1.7: Unauthenticated request is rejected

- Given no auth token is provided
- When `GET /api/services` is called
- Then the response MUST be HTTP 401

---

### Requirement W1: InMemoryServiceTechnologyRepository ordering parity

**Priority**: MUST

#### Scenario W1.1: In-memory list is ordered by name ascending

- Given multiple `ServiceTechnology` records seeded in arbitrary insertion order
- When `InMemoryServiceTechnologyRepository.list()` is called
- Then the returned array MUST be ordered by `name` ascending, matching the Prisma adapter's `orderBy: { name: 'asc' }`

## Constraints

- `name` MUST be unique; case-insensitive comparison is enforced at the use-case layer (normalize to lowercase before comparison), but stored as provided
- `description` is optional (`String?`)
- The `ServiceTechnologyRepository` port MUST include a `countServicesUsingTechnology(name: string): Promise<number>` method to support the delete guard
- All endpoints MUST require authentication via the existing `authMiddleware`
- Use cases MUST depend only on the `ServiceTechnologyRepository` port — no direct Prisma imports
- DTOs MUST be returned from use cases; Prisma entities MUST NOT be returned from routes
- `InMemoryServiceTechnologyRepository` MUST implement the full port for use-case tests
- `GET /api/services` MUST be backed by a dedicated `ServiceRepository` port (global listing), not by `CustomerRepository.listServices` (per-client, no clientName/technology)
- The `GET /api/services` envelope MUST use `pageSize` (not `limit`) to match the frontend `PaginatedResponse<T>` contract
