# Spec Delta: Scheduling — Stage Model Foundation

**Change**: `scheduling-foundation-stage-model`
**Base spec**: `openspec/specs/scheduling/spec.md`
**Capability**: `scheduling`

This delta moves the `scheduling` capability from a hardcoded 4-value `status` enum to a configurable `Workflow + Stage` model. Auth, listing, get-by-id, create/update/delete, and shape requirements that are unaffected by the stage model are **retained** from the base spec without modification.

---

## Removed Requirements

- **REQ-STATUS-1 (Valid status transition returns 200)** — Replaced by REQ-STAGE-1 (move to stage). The PATCH endpoint is renamed; the old `/status` endpoint persists only as a deprecated alias (REQ-STAGE-DEP-1..3).
- **REQ-STATUS-2 (Invalid status value returns 400)** — Replaced by REQ-STAGE-2 (invalid stageId returns 400/404). The closed enum no longer exists in the request schema.
- **REQ-STATUS-3 (Missing status field returns 400)** — Replaced by REQ-STAGE-3 (missing stageId returns 400).
- **REQ-VAL-3 (`UpdateStatusSchema` only accepts the 4 valid status values)** — `UpdateStatusSchema` is marked `@deprecated`. The constraint still applies to the deprecated route only.
- **REQ-VAL-1 / REQ-VAL-2 — `status` field restriction to the 4-value enum** — Removed. `status` is no longer a writable field on Create / Update; it MAY appear in responses only as a derived deprecated alias.
- **REQ-SHAPE-2 row for `status`** as a non-nullable `'pending' | 'in_progress' | 'completed' | 'cancelled'` — Replaced by REQ-SHAPE-3 (response carries `stageId`, `stageCategory`, and deprecated `status` derived).
- **Appendix `TaskStatus` enum** — Removed from the writable API surface. Retained only inside the deprecation shim until the next change drops it.

## Modified Requirements

### REQ-CREATE-1 (modified): Valid body creates task and returns 201

The `status` field MUST NOT be required on `POST /api/scheduling`. The body MAY include `stageId: string` instead. When `stageId` is omitted, the server MUST default the task to the first Stage of category `nuevo` in the **Default workflow** (as seeded). All other create requirements (REQ-CREATE-2, 3, 5, 6, 7, 8) remain unchanged.

### REQ-CREATE-4 (modified): Invalid stageId returns 400 or 404

**Given** an authenticated `POST /api/scheduling` request
**And** the body contains `stageId: "<non-existent-uuid>"`
**When** the request is processed
**Then** the server MUST respond with HTTP 404
**And** the body MUST contain `{ "code": "STAGE_NOT_FOUND" }`

A malformed (non-string) `stageId` MUST return 400 with `{ "code": "VALIDATION_ERROR" }`.

### REQ-UPDATE-4 (modified): Invalid stageId in PUT body returns 400/404

**Given** an authenticated `PUT /api/scheduling/:id` request
**And** the body contains a `stageId` that is malformed (non-string)
**When** the request is processed
**Then** the server MUST respond with HTTP 400 with `{ "code": "VALIDATION_ERROR" }`

**Given** the same request with a well-formed but non-existent `stageId`
**Then** the server MUST respond with HTTP 404 with `{ "code": "STAGE_NOT_FOUND" }`

### REQ-SHAPE-2 (modified): Task object field structure

Every `ScheduledTask` response object MUST contain at minimum the following fields (replacing the prior `status` row with `stageId` + `stageCategory`; retaining deprecated `status` for one release):

| Field | Type | Nullable |
|-------|------|----------|
| `id` | `string` | No |
| `title` | `string` | No |
| `description` | `string \| null` | Yes |
| `assignedTo` | `string \| null` | Yes |
| `assignedToId` | `string \| null` | Yes |
| `clientId` | `string \| null` | Yes |
| `clientName` | `string \| null` | Yes |
| `stageId` | `string` | No |
| `stageCategory` | `'nuevo' \| 'enProgreso' \| 'hecho'` | No |
| `status` (deprecated) | `'pending' \| 'in_progress' \| 'completed' \| 'cancelled'` | No |
| `priority` | `'low' \| 'normal' \| 'high' \| 'urgent'` | No |
| `scheduledDate` | `string` | No |
| `scheduledTime` | `string` | No |
| `estimatedHours` | `number` | No |
| `address` | `string \| null` | Yes |
| `coordinates` | `{ lat: number; lng: number } \| null` | Yes |
| `category` | `'installation' \| 'repair' \| 'maintenance' \| 'inspection' \| 'other'` | No |
| `projectId` | `string \| null` | Yes |
| `projectName` | `string \| null` | Yes |
| `completedAt` | `string \| null` | Yes |
| `notes` | `string \| null` | Yes |

### REQ-VAL-1 (modified): `CreateTaskSchema` covers all required fields

The schema MUST require: `title`, `priority`, `scheduledDate`, `scheduledTime`, `estimatedHours`, `category`.
The schema MUST allow (optional / nullable): `description`, `assignedTo`, `assignedToId`, `address`, `notes`, `clientId`, `clientName`, `coordinates`, `projectId`, `completedAt`, **`stageId`**.
`stageId` MUST be `z.string().uuid().optional()`.
`status` MUST NOT appear in `CreateTaskSchema`.

### REQ-VAL-2 (modified): `UpdateTaskSchema` is a partial of `CreateTaskSchema`

All fields MUST be optional. `stageId` MUST be validated the same way as in create. `status` MUST NOT appear.

---

## Added Requirements

### REQ-STAGE-1: Move task to stage returns 200

**Given** an authenticated `PATCH /api/scheduling/:id/stage` request
**And** the task with the given `id` exists
**And** the body contains `{ "stageId": "<valid-uuid>" }` referencing an existing Stage
**When** the request is processed
**Then** the server MUST respond with HTTP 200
**And** the body MUST be the updated `ScheduledTask`
**And** the body `stageId` MUST equal the requested value
**And** the body `stageCategory` MUST equal the `category` of the referenced Stage

### REQ-STAGE-2: Non-existent stageId returns 404

**Given** an authenticated `PATCH /api/scheduling/:id/stage` request
**And** the body contains a well-formed `stageId` that does not exist
**When** the request is processed
**Then** the server MUST respond with HTTP 404
**And** the body MUST contain `{ "code": "STAGE_NOT_FOUND" }`

### REQ-STAGE-3: Missing or malformed stageId returns 400

**Given** an authenticated `PATCH /api/scheduling/:id/stage` request
**And** the body is `{}` (no `stageId`) OR contains `stageId` that is not a string
**When** the request is processed
**Then** the server MUST respond with HTTP 400
**And** the body MUST contain `{ "code": "VALIDATION_ERROR" }`

### REQ-STAGE-4: Task not found returns 404

**Given** an authenticated `PATCH /api/scheduling/:id/stage` request
**And** the task with the given `id` does not exist
**When** the request is processed with a valid `stageId`
**Then** the server MUST respond with HTTP 404
**And** the body MUST contain `{ "code": "TASK_NOT_FOUND" }`

### REQ-STAGE-CATEGORY-1: stageCategory is derived from Stage

**Given** any response returning a `ScheduledTask`
**When** the task's `stageId` refers to a Stage with `category: X`
**Then** the response `stageCategory` MUST equal `X` (one of `'nuevo' | 'enProgreso' | 'hecho'`)
**And** `stageCategory` MUST NOT be writable through any API endpoint

### REQ-STAGE-COMPLETED-1: Moving to a `hecho` category stage auto-sets `completedAt`

**Given** an authenticated `PATCH /api/scheduling/:id/stage` request
**And** the task with the given `id` exists and has `completedAt: null`
**And** the body contains `{ "stageId": "<id-of-a-hecho-category-stage>" }`
**When** the request is processed
**Then** the response `completedAt` MUST be a non-null ISO 8601 timestamp approximating the request time

### REQ-STAGE-COMPLETED-2: Moving to a non-`hecho` stage does not overwrite `completedAt`

**Given** an authenticated `PATCH /api/scheduling/:id/stage` request
**And** the task has `completedAt` already set
**And** the body contains a `stageId` whose Stage category is `'nuevo'` or `'enProgreso'`
**When** the request is processed
**Then** the response `completedAt` MUST retain its original value (MUST NOT be overwritten to `null`)

### REQ-STAGE-PROJECTNAME-1: Response includes projectName when task has a linked project

**Given** an authenticated `PATCH /api/scheduling/:id/stage` request
**And** the task is linked to a project (`projectId` is set)
**And** the body contains a valid `stageId`
**When** the request is processed
**Then** the response `projectName` MUST be the name of the linked project (non-null string)

### REQ-STAGE-DEFAULT-1: Create without stageId defaults to Default workflow's first Nuevo stage

**Given** an authenticated `POST /api/scheduling` request
**And** the body omits `stageId`
**When** the request is processed
**Then** the created task `stageId` MUST equal the ID of the Stage in the Default workflow with `category: 'nuevo'` and the lowest `order` value (i.e. the seeded "Nuevo" stage)
**And** `stageCategory` MUST be `'nuevo'`

### Deprecation Aliases (REQ-STAGE-DEP-*)

These requirements describe backward-compatibility behavior retained for **one release** only. The next change (`scheduling-tasks-enrich` or a dedicated cleanup) MUST drop these.

### REQ-STAGE-DEP-1: `PATCH /:id/status` keeps working as an alias

**Given** an authenticated `PATCH /api/scheduling/:id/status` request
**And** the body contains `{ "status": "<one of pending|in_progress|completed|cancelled>" }`
**When** the request is processed
**Then** the server MUST respond with HTTP 200
**And** the server MUST internally translate the legacy `status` to the matching Stage in the **Default workflow** using the mapping:
  - `pending → "Nuevo"` (category `nuevo`)
  - `in_progress → "En progreso"` (category `enProgreso`)
  - `completed → "Hecho"` (category `hecho`)
  - `cancelled → "Anulado-Cancelado"` (category `hecho`)
**And** the response MUST behave identically to `PATCH /:id/stage` (same body shape, same `completedAt` semantics — see REQ-STAGE-COMPLETED-1/2).

### REQ-STAGE-DEP-2: Deprecated route logs a warning

When `PATCH /:id/status` is invoked, the server MUST emit a `console.warn` (or equivalent structured log) with message containing `"deprecated"` and the route name. This SHOULD NOT change the HTTP response.

### REQ-STAGE-DEP-3: Deprecated `status` field present in responses

Every response that returns a `ScheduledTask` MUST include a `status` field derived from the task's Stage according to the mapping in REQ-STAGE-DEP-1 (reverse direction). For Stages outside the Default workflow whose name does not match the four legacy labels, `status` MUST be the closest match by `stageCategory`: `nuevo → 'pending'`, `enProgreso → 'in_progress'`, `hecho → 'completed'` (or `'cancelled'` if the Stage name contains `"cancel"` or `"anul"` case-insensitively).

---

## Modified Section: Appendix — Enum Reference

| Type | Values | Status |
|------|--------|--------|
| `TaskStatus` | `pending`, `in_progress`, `completed`, `cancelled` | **Deprecated** — present only in legacy response field; not writable |
| `StageCategory` | `nuevo`, `enProgreso`, `hecho` | New — read-only response field, derived from Stage |
| `TaskPriority` | `low`, `normal`, `high`, `urgent` | Unchanged |
| `category` | `installation`, `repair`, `maintenance`, `inspection`, `other` | Unchanged |

## Added Section: Error Codes

The base spec's error codes (REQ-AUTH, REQ-NULL, etc.) remain. Add:

| Scenario | HTTP Status | `code` |
|----------|-------------|--------|
| Stage ID not found | 404 | `STAGE_NOT_FOUND` |
