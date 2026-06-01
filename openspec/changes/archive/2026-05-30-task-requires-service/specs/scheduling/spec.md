# Delta Spec: task-requires-service — scheduling capability

**Capability**: `scheduling`
**Type**: MODIFIED (delta over existing scheduling spec)
**Change**: `task-requires-service`
**Routes affected**: `POST /api/scheduling` (create task only)

---

## Context

This delta modifies the `POST /api/scheduling` create path. All other routes and requirements from the base `scheduling` spec remain unchanged. The single behavioral change is: `serviceId` transitions from optional-nullable to **required**.

The DB column `ScheduledTask.serviceId` stays `String?` (nullable, `onDelete: SetNull`) — the constraint is enforced at the application layer only.

---

## MODIFIED Requirements

### REQ-CREATE-SERVICE-1: `serviceId` is required in create body

**Given** an authenticated `POST /api/scheduling` request  
**And** the body omits `serviceId` entirely  
**When** the request is processed  
**Then** the server MUST respond with HTTP 400  
**And** the body MUST contain `{ "code": "VALIDATION_ERROR" }`  
**And** the `details` field SHOULD name `serviceId` as the failing field

### REQ-CREATE-SERVICE-2: `serviceId: null` is rejected

**Given** an authenticated `POST /api/scheduling` request  
**And** the body contains `serviceId: null`  
**When** the request is processed  
**Then** the server MUST respond with HTTP 400  
**And** the body MUST contain `{ "code": "VALIDATION_ERROR" }`

*Note: This scenario inverts the previous behavior where `serviceId: null` was accepted.*

### REQ-CREATE-SERVICE-3: Empty string `serviceId` is rejected

**Given** an authenticated `POST /api/scheduling` request  
**And** the body contains `serviceId: ""`  
**When** the request is processed  
**Then** the server MUST respond with HTTP 400  
**And** the body MUST contain `{ "code": "VALIDATION_ERROR" }`

### REQ-CREATE-SERVICE-4: Non-existent `serviceId` is rejected

**Given** an authenticated `POST /api/scheduling` request  
**And** the body contains a valid non-empty `serviceId`  
**And** no service with that ID exists in the system  
**When** the request is processed  
**Then** the server MUST respond with HTTP 422 or 404 (as mapped by the route handler from `ReferenceNotFoundError`)  
**And** the body MUST contain `{ "code": "REFERENCE_NOT_FOUND" }` or equivalent domain error code

### REQ-CREATE-SERVICE-5: Valid `serviceId` creates task successfully

**Given** an authenticated `POST /api/scheduling` request  
**And** the body contains a `serviceId` pointing to an existing service  
**And** all other required fields are valid  
**When** the request is processed  
**Then** the server MUST respond with HTTP 201  
**And** the body MUST be the newly created `ScheduledTask` with `serviceId` populated  
**And** the FK validation order MUST remain: customer → service → partner → reporter → assignee → watchers (REQ-FK-ORDER-1 preserved)

---

## MODIFIED: CreateTask Use Case

### REQ-UC-SERVICE-1: `serviceId` validation is unconditional

**Given** `CreateTask.execute` is called with a `CreateTaskInput`  
**And** `serviceId` is always present (required field, never null)  
**When** executing the FK validation block  
**Then** `serviceLookup.findById(data.serviceId)` MUST be called without a null guard  
**And** if not found, MUST throw `ReferenceNotFoundError('service', data.serviceId)`

*Note: The previous `if (data.serviceId != null)` guard MUST be removed.*

---

## MODIFIED: DTO Schema

### REQ-DTO-SERVICE-1: `serviceId` in `CreateTaskSchema` is required and non-nullable

**Given** `CreateTaskBaseSchema` in `application/dto/scheduling.dto.ts`  
**When** `serviceId` is parsed  
**Then** the field MUST be `z.string().min(1)` — NOT `.nullable().optional()`  
**And** `tsc --noEmit` MUST pass with this type change  
**And** `UpdateTaskSchema` (which is `.partial()` of the base) MUST still treat `serviceId` as optional — no change to update behavior

---

## Test Inversion Note

The existing test at approximately line 87-99 in `src/__tests__/application/CreateTask.test.ts` that passes `serviceId: null` and expects SUCCESS must be **inverted** to expect `ReferenceNotFoundError` or moved to a route-level test expecting `400 VALIDATION_ERROR`. The test fixture must be updated to always include a valid `serviceId`.

---

## Non-Goals (explicitly excluded from this delta)

- `PUT /api/scheduling/:id` update path — `serviceId` remains optional for edits.
- `GET`, `DELETE`, `PATCH /:id/status` — unchanged.
- DB schema migration — column stays nullable.
- Backfilling existing tasks with a `serviceId`.
