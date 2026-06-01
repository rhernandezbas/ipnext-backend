# Spec Delta: Scheduling Tasks Enrich

**Capability**: `scheduling`
**Type**: Delta — modifies the consolidated `openspec/specs/scheduling/spec.md` (base = original spec + change 1 delta + change 2 delta, all already absorbed).
**Change**: `scheduling-tasks-enrich`
**Routes touched**: same set (`GET/POST/PUT/PATCH/DELETE /api/scheduling[...]`). No new routes. No URL changes.

---

## Removed Requirements

(none — legacy fields stay as deprecated read-only; their requirements remain in the base spec for one release.)

---

## Modified Requirements

### REQ-SHAPE-2: Task object field structure (MODIFIED)

The minimum field set in every `ScheduledTask` response object is extended to include the new fields below. Existing fields remain present and unchanged in type/nullability.

Added fields:

| Field | Type | Nullable |
|-------|------|----------|
| `startDate` | `string` (ISO 8601 with offset) | Yes |
| `endDate` | `string` (ISO 8601 with offset) | Yes |
| `customerId` | `string` | Yes |
| `customerName` | `string` (derived from JOIN) | Yes |
| `serviceId` | `string` | Yes |
| `partnerId` | `string` | Yes |
| `reporterId` | `string` | Yes |
| `assigneeId` | `string` | Yes |
| `assigneeName` | `string` (derived from JOIN) | Yes |
| `watcherIds` | `string[]` | No (empty array when none) |
| `travelTimeTo` | `number` (integer, minutes) | Yes |
| `travelTimeFrom` | `number` (integer, minutes) | Yes |

Deprecated fields (still present, still typed as before, for one release):

| Field | Type | Nullable | Note |
|-------|------|----------|------|
| `scheduledDate` | `string` | Yes | DEPRECATED — use `startDate` |
| `scheduledTime` | `string` | Yes | DEPRECATED — use `startDate` |
| `clientId` | `string` | Yes | DEPRECATED — use `customerId` |
| `clientName` | `string` | Yes | DEPRECATED — derived `customerName` is authoritative |
| `assignedTo` | `string` | Yes | DEPRECATED — derived `assigneeName` is authoritative |
| `assignedToId` | `string` | Yes | DEPRECATED — use `assigneeId` |
| `status` | `'pending' \| 'in_progress' \| 'completed' \| 'cancelled'` | No | DEPRECATED (change 1) — use `stageCategory` |

### REQ-NULL-7: `clientId` / `clientName` / `customerId` / `customerName` MAY be `null` (MODIFIED)

The API MUST accept and return all four of `clientId`, `clientName`, `customerId`, `customerName` as `string | null`. When `customerId` is set, the adapter MUST populate `customerName` from a JOIN on `Client.name`; the legacy `clientName` MAY be populated from the deprecated column or fall back to the same JOIN value (implementation choice).

### REQ-VAL-1: `CreateTaskSchema` covers all required fields (MODIFIED)

The schema MUST require: `title`, `priority`, `estimatedHours`, `category`. (`scheduledDate`, `scheduledTime`, `status` are no longer required even when present — they are deprecated.)

The schema MUST allow (nullable/optional): `description`, `assignedTo`, `assignedToId`, `address`, `notes`, `clientId`, `clientName`, `coordinates`, `projectId`, `completedAt`, **plus** `startDate`, `endDate`, `customerId`, `serviceId`, `partnerId`, `reporterId`, `assigneeId`, `watcherIds`, `travelTimeTo`, `travelTimeFrom`.

Type constraints:

- `startDate`, `endDate`: `z.string().datetime({ offset: true }).nullable().optional()` — ISO 8601 with offset (e.g. `2026-05-20T09:00:00-03:00`).
- `customerId`, `serviceId`, `partnerId`, `reporterId`, `assigneeId`: `z.string().min(1).nullable().optional()` (NOT `.uuid()` — mixed ID format).
- `watcherIds`: `z.array(z.string().min(1)).optional()`.
- `travelTimeTo`, `travelTimeFrom`: `z.number().int().nonnegative().nullable().optional()`.
- `priority` enum unchanged: `z.enum(['low', 'normal', 'high', 'urgent'])`.
- `category` enum unchanged.

A `superRefine` MUST reject bodies where both `startDate` and `endDate` are present AND `endDate < startDate`. The rejection MUST produce `code: 'VALIDATION_ERROR'` with a `details` entry pointing at `endDate`.

### REQ-CREATE-1: Valid body creates task and returns 201 (MODIFIED)

In addition to the original contract, when the body includes any of `customerId/serviceId/partnerId/reporterId/assigneeId/watcherIds`, those FK references MUST be validated in the use case (see REQ-CUSTOMER-1, REQ-WATCHER-1). On success, the response body MUST include the full new-field set with values echoed back AND `customerName`/`assigneeName` resolved via JOIN.

### REQ-UPDATE-1: Valid partial body updates task and returns 200 (MODIFIED)

Same change as REQ-CREATE-1 for FK validation. When `watcherIds` is present in the body, the watcher set is replaced atomically (REQ-WATCHER-1). When `watcherIds` is OMITTED, the watcher set is untouched.

---

## Added Requirements

### REQ-DATETIME-1: `startDate` and `endDate` contract

#### Scenario: Valid ISO 8601 is accepted and round-trips

**Given** an authenticated `POST /api/scheduling` request
**And** the body contains `startDate: "2026-05-20T09:00:00-03:00"` and `endDate: "2026-05-20T11:00:00-03:00"`
**When** the request is processed
**Then** the server MUST respond with HTTP 201
**And** the response body `startDate` MUST be an ISO 8601 string equivalent (the same instant; offset normalization is acceptable)
**And** the response body `endDate` MUST be likewise equivalent

#### Scenario: `endDate` before `startDate` is rejected

**Given** an authenticated `POST /api/scheduling` request
**And** the body contains `startDate: "2026-05-20T11:00:00-03:00"` and `endDate: "2026-05-20T09:00:00-03:00"`
**When** the request is processed
**Then** the server MUST respond with HTTP 400
**And** the body MUST contain `{ "code": "VALIDATION_ERROR" }`
**And** `details` MUST reference `endDate`

#### Scenario: Either field MAY be `null`

**Given** an authenticated `POST /api/scheduling` request
**And** the body contains `startDate: null` and `endDate: null`
**When** the request is processed
**Then** the server MUST respond with HTTP 201
**And** the response `startDate` MUST be `null`
**And** the response `endDate` MUST be `null`

#### Scenario: Malformed string is rejected

**Given** an authenticated `POST /api/scheduling` request
**And** the body contains `startDate: "20/05/2026 09:00"`
**When** the request is processed
**Then** the server MUST respond with HTTP 400
**And** the body MUST contain `{ "code": "VALIDATION_ERROR" }`

### REQ-CUSTOMER-1: `customerId` FK validation

#### Scenario: Non-existent `customerId` returns 404 `CUSTOMER_NOT_FOUND`

**Given** an authenticated `POST /api/scheduling` request
**And** the body contains `customerId: "does-not-exist"`
**When** the request is processed
**Then** the server MUST respond with HTTP 404
**And** the body MUST contain `{ "code": "CUSTOMER_NOT_FOUND" }`

#### Scenario: Existing `customerId` resolves `customerName` via JOIN

**Given** an authenticated `POST /api/scheduling` request
**And** the body contains `customerId: "<existing-client-id>"` (Client.name = "Juan García")
**When** the request is processed
**Then** the server MUST respond with HTTP 201
**And** the response `customerId` MUST equal the input
**And** the response `customerName` MUST equal "Juan García"

#### Scenario: Same contract for `serviceId`, `partnerId`, `reporterId`, `assigneeId`

For each of `serviceId`, `partnerId`, `reporterId`, `assigneeId`, the analogous scenarios apply with HTTP `code` values `SERVICE_NOT_FOUND`, `PARTNER_NOT_FOUND`, `REPORTER_NOT_FOUND`, `ASSIGNEE_NOT_FOUND` respectively.

### REQ-WATCHER-1: Watchers replace-set semantics

#### Scenario: `watcherIds` is authoritative when present

**Given** a task with watchers `[a1, a2, a3]`
**And** an authenticated `PUT /api/scheduling/:id` request with body `{ "watcherIds": ["a1"] }`
**When** the request is processed
**Then** the server MUST respond with HTTP 200
**And** the response `watcherIds` MUST equal `["a1"]`
**And** subsequent `GET /api/scheduling/:id` MUST return `watcherIds: ["a1"]`

#### Scenario: Empty array clears the set

**Given** a task with watchers `[a1, a2]`
**And** an authenticated `PUT /api/scheduling/:id` request with body `{ "watcherIds": [] }`
**When** the request is processed
**Then** the response `watcherIds` MUST be `[]`

#### Scenario: Omitted `watcherIds` preserves the set

**Given** a task with watchers `[a1, a2]`
**And** an authenticated `PUT /api/scheduling/:id` request whose body does NOT include `watcherIds`
**When** the request is processed
**Then** the response `watcherIds` MUST equal `[a1, a2]` (unchanged)

#### Scenario: Non-existent watcher id rejects the whole update

**Given** an authenticated `PUT /api/scheduling/:id` request with body `{ "watcherIds": ["a1", "ghost"] }`
**And** admin `ghost` does not exist
**When** the request is processed
**Then** the server MUST respond with HTTP 404
**And** the body MUST contain `{ "code": "WATCHER_NOT_FOUND" }`
**And** the watcher set on the persisted task MUST be unchanged (atomic — no partial update)

### REQ-TRAVEL-1: Travel-time bounds

#### Scenario: Non-negative integer accepted

**Given** an authenticated `POST /api/scheduling` request
**And** the body contains `travelTimeTo: 15` and `travelTimeFrom: 20`
**When** the request is processed
**Then** the server MUST respond with HTTP 201
**And** the response MUST echo both values

#### Scenario: Negative is rejected

**Given** an authenticated `POST /api/scheduling` request
**And** the body contains `travelTimeTo: -5`
**When** the request is processed
**Then** the server MUST respond with HTTP 400
**And** the body MUST contain `{ "code": "VALIDATION_ERROR" }`

#### Scenario: Non-integer is rejected

**Given** an authenticated `POST /api/scheduling` request
**And** the body contains `travelTimeFrom: 2.5`
**When** the request is processed
**Then** the server MUST respond with HTTP 400
**And** the body MUST contain `{ "code": "VALIDATION_ERROR" }`

#### Scenario: `null` is accepted

**Given** an authenticated `POST /api/scheduling` request
**And** the body contains `travelTimeTo: null` and `travelTimeFrom: null`
**When** the request is processed
**Then** the response MUST echo both as `null`

### REQ-RICH-DESC-1: Rich-text description accepted as-is

#### Scenario: HTML content is stored and returned unchanged

**Given** an authenticated `POST /api/scheduling` request
**And** the body contains `description: "<p>hello <strong>world</strong></p>"`
**When** the request is processed
**Then** the server MUST respond with HTTP 201
**And** the response `description` MUST equal the exact input string (no sanitization, no transformation)

#### Scenario: Plain-text content remains plain text

**Given** an authenticated `POST /api/scheduling` request
**And** the body contains `description: "just plain text"`
**When** the request is processed
**Then** the response `description` MUST equal `"just plain text"` (no `<p>` wrap, no escaping)

#### Non-goal: server-side XSS sanitization

The server MUST NOT sanitize HTML in `description`. Consumers MUST render through DOMPurify (or equivalent). This is a deliberate non-goal — documented in change 3 design §AD-6 — to keep the boundary clean and avoid divergent server-side HTML semantics.

### REQ-FK-ORDER-1: FK validation is deterministic

#### Scenario: First missing FK in the canonical order wins

**Given** an authenticated `POST /api/scheduling` request
**And** the body references BOTH a non-existent `customerId` AND a non-existent `assigneeId`
**When** the request is processed
**Then** the server MUST respond with HTTP 404
**And** the body MUST contain `{ "code": "CUSTOMER_NOT_FOUND" }` (NOT `ASSIGNEE_NOT_FOUND`)

The canonical FK validation order is: `customerId → serviceId → partnerId → reporterId → assigneeId → watcherIds[*]`. The first missing reference determines the error.

### REQ-DEPRECATED-1: Legacy fields are still returned

#### Scenario: Legacy fields appear alongside new fields

**Given** an authenticated `GET /api/scheduling/:id` for a task that has BOTH legacy and new field values populated
**When** the request is processed
**Then** the response body MUST include all of `scheduledDate`, `scheduledTime`, `clientId`, `clientName`, `assignedTo`, `assignedToId`, `status`, AND all of `startDate`, `endDate`, `customerId`, `customerName`, `assigneeId`, `assigneeName`, etc.
**And** consumers MAY read either set during the deprecation window
**And** the new fields are authoritative — the legacy fields are best-effort fallbacks during the deprecation window only.

---

## Appendix: New Error Codes

| Scenario | HTTP Status | `code` |
|----------|-------------|--------|
| Non-existent `customerId` | 404 | `CUSTOMER_NOT_FOUND` |
| Non-existent `serviceId` | 404 | `SERVICE_NOT_FOUND` |
| Non-existent `partnerId` | 404 | `PARTNER_NOT_FOUND` |
| Non-existent `reporterId` | 404 | `REPORTER_NOT_FOUND` |
| Non-existent `assigneeId` | 404 | `ASSIGNEE_NOT_FOUND` |
| Non-existent `watcherIds[i]` | 404 | `WATCHER_NOT_FOUND` |
| `endDate < startDate` | 400 | `VALIDATION_ERROR` |
| Negative or non-integer `travelTimeTo/From` | 400 | `VALIDATION_ERROR` |
| Malformed `startDate`/`endDate` | 400 | `VALIDATION_ERROR` |
