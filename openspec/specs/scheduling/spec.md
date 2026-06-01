# Spec: Scheduling Capability

**Capability**: `scheduling`
**Type**: New (full HTTP capability — no prior spec exists)
**Change**: `scheduling-hardening`
**Routes**: `GET /api/scheduling`, `GET /api/scheduling/:id`, `POST /api/scheduling`, `PUT /api/scheduling/:id`, `DELETE /api/scheduling/:id`, `PATCH /api/scheduling/:id/status`

---

## 1. Authentication

All 6 scheduling routes MUST enforce authentication via the `auth_token` cookie using `createAuthMiddleware(JwtAuthAdapter)`.

### REQ-AUTH-1: Missing cookie is rejected on GET /

**Given** a request to `GET /api/scheduling` without an `auth_token` cookie  
**When** the request is received  
**Then** the server MUST respond with HTTP 401  
**And** the body MUST contain `{ "code": "UNAUTHORIZED" }`  
**And** the response MUST NOT include any task data

### REQ-AUTH-2: Missing cookie is rejected on GET /:id

**Given** a request to `GET /api/scheduling/1` without an `auth_token` cookie  
**When** the request is received  
**Then** the server MUST respond with HTTP 401  
**And** the body MUST contain `{ "code": "UNAUTHORIZED" }`

### REQ-AUTH-3: Missing cookie is rejected on POST /

**Given** a request to `POST /api/scheduling` without an `auth_token` cookie  
**When** the request is received with a valid body  
**Then** the server MUST respond with HTTP 401  
**And** the body MUST contain `{ "code": "UNAUTHORIZED" }`

### REQ-AUTH-4: Missing cookie is rejected on PUT /:id

**Given** a request to `PUT /api/scheduling/1` without an `auth_token` cookie  
**When** the request is received with a valid body  
**Then** the server MUST respond with HTTP 401  
**And** the body MUST contain `{ "code": "UNAUTHORIZED" }`

### REQ-AUTH-5: Missing cookie is rejected on DELETE /:id

**Given** a request to `DELETE /api/scheduling/1` without an `auth_token` cookie  
**When** the request is received  
**Then** the server MUST respond with HTTP 401  
**And** the body MUST contain `{ "code": "UNAUTHORIZED" }`

### REQ-AUTH-6: Missing cookie is rejected on PATCH /:id/status

**Given** a request to `PATCH /api/scheduling/1/status` without an `auth_token` cookie  
**When** the request is received with `{ "status": "completed" }`  
**Then** the server MUST respond with HTTP 401  
**And** the body MUST contain `{ "code": "UNAUTHORIZED" }`

### REQ-AUTH-7: Invalid token is rejected

**Given** a request to any scheduling route with an `auth_token` cookie whose value cannot be verified by `JwtAuthAdapter.getSession`  
**When** the request is received  
**Then** the server MUST respond with HTTP 401  
**And** the body MUST contain a `code` field (either `"UNAUTHORIZED"` or the `AuthenticationError.code` value)

### REQ-AUTH-8: Valid token is forwarded to the handler

**Given** a request to any scheduling route with a valid `auth_token` cookie  
**When** `JwtAuthAdapter.getSession` resolves a `User` object  
**Then** the server MUST call the next handler (the use case)  
**And** MUST NOT respond with 401

---

## 2. List Tasks

### REQ-LIST-1: Returns all tasks as a JSON array

**Given** an authenticated request to `GET /api/scheduling`  
**When** the repository contains tasks  
**Then** the server MUST respond with HTTP 200  
**And** the body MUST be a JSON array  
**And** each element MUST be a `ScheduledTask` object

### REQ-LIST-2: Returns empty array when no tasks exist

**Given** an authenticated request to `GET /api/scheduling`  
**When** the repository contains no tasks  
**Then** the server MUST respond with HTTP 200  
**And** the body MUST be an empty JSON array `[]`

### REQ-LIST-3: Every item in the list includes projectName

**Given** an authenticated request to `GET /api/scheduling`  
**When** the repository returns tasks, some linked to a project and some not  
**Then** every item in the response array MUST include a `projectName` field  
**And** items linked to a project MUST have `projectName` as a non-null string  
**And** items not linked to a project MUST have `projectName` as `null`

---

## 3. Get Task by ID

### REQ-GET-1: Returns 200 with task when ID exists

**Given** an authenticated request to `GET /api/scheduling/:id`  
**When** the repository contains a task with the given `id`  
**Then** the server MUST respond with HTTP 200  
**And** the body MUST be a single `ScheduledTask` object  
**And** the body MUST include a `projectName` field (see REQ-SHAPE-1)

### REQ-GET-2: Returns 404 when ID does not exist

**Given** an authenticated request to `GET /api/scheduling/:id`  
**When** no task with the given `id` exists in the repository  
**Then** the server MUST respond with HTTP 404  
**And** the body MUST contain `{ "code": "TASK_NOT_FOUND" }`

---

## 4. Create Task

### REQ-CREATE-1: Valid body creates task and returns 201

**Given** an authenticated `POST /api/scheduling` request  
**And** the body is a valid `CreateTaskSchema` object with all required fields  
**When** the request is processed  
**Then** the server MUST respond with HTTP 201  
**And** the body MUST be the newly created `ScheduledTask` with a generated `id`  
**And** the body MUST include a `projectName` field

### REQ-CREATE-2: Missing required field returns 400

**Given** an authenticated `POST /api/scheduling` request  
**And** the body omits a required field (e.g. `title`)  
**When** the request is processed  
**Then** the server MUST respond with HTTP 400  
**And** the body MUST contain `{ "code": "VALIDATION_ERROR" }`  
**And** the body SHOULD include a `details` field describing which fields failed validation

### REQ-CREATE-3: Invalid field type returns 400

**Given** an authenticated `POST /api/scheduling` request  
**And** a field has a wrong type (e.g. `estimatedHours: "two"` instead of a number)  
**When** the request is processed  
**Then** the server MUST respond with HTTP 400  
**And** the body MUST contain `{ "code": "VALIDATION_ERROR" }`

### REQ-CREATE-4: Invalid status value returns 400

**Given** an authenticated `POST /api/scheduling` request  
**And** the body contains `status: "unknown_value"`  
**When** the request is processed  
**Then** the server MUST respond with HTTP 400  
**And** the body MUST contain `{ "code": "VALIDATION_ERROR" }`

### REQ-CREATE-5: Invalid priority value returns 400

**Given** an authenticated `POST /api/scheduling` request  
**And** the body contains `priority: "critical"` (not in the enum)  
**When** the request is processed  
**Then** the server MUST respond with HTTP 400  
**And** the body MUST contain `{ "code": "VALIDATION_ERROR" }`

### REQ-CREATE-6: Invalid category value returns 400

**Given** an authenticated `POST /api/scheduling` request  
**And** the body contains `category: "demolition"` (not in the enum)  
**When** the request is processed  
**Then** the server MUST respond with HTTP 400  
**And** the body MUST contain `{ "code": "VALIDATION_ERROR" }`

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

*Note: This inverts the previous behavior where `serviceId: null` was accepted.*

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

### REQ-CREATE-7: Nullable fields MAY be null

**Given** an authenticated `POST /api/scheduling` request  
**And** the body contains `description: null`, `assignedTo: null`, `assignedToId: null`, `address: null`, `notes: null`  
**When** the request is processed  
**Then** the server MUST respond with HTTP 201  
**And** the returned task MUST carry those fields as `null`

### REQ-CREATE-8: Nullable fields MAY be strings

**Given** an authenticated `POST /api/scheduling` request  
**And** the body contains `description: "text"`, `assignedTo: "Técnico"`, `assignedToId: "u-1"`, `address: "Av. 123"`, `notes: "Llevar kit"`  
**When** the request is processed  
**Then** the server MUST respond with HTTP 201  
**And** the returned task MUST carry those fields as non-null strings

### REQ-CREATE-9: Reporter defaults to the authenticated user when omitted

**Given** an authenticated `POST /api/scheduling` request  
**And** the body omits `reporterId` (absent or explicit `null`)  
**When** the request is processed  
**Then** the server MUST respond with HTTP 201  
**And** the created `ScheduledTask`'s `reporterId` MUST equal `req.user.id` (the authenticated admin)

Rationale: `User.id == admin.id` by construction in `JwtAuthAdapter` (the JWT is issued from the admin record at login). The default value passes the existing FK validation against `adminLookup`.

### REQ-CREATE-10: Explicit reporterId in body wins over the default

**Given** an authenticated `POST /api/scheduling` request  
**And** the body provides a `reporterId` belonging to an existing admin  
**When** the request is processed  
**Then** the server MUST respond with HTTP 201  
**And** the created `ScheduledTask`'s `reporterId` MUST equal the value from the body (NOT `req.user.id`)

### REQ-CREATE-11: Defaulted reporter is still validated against the admin lookup

**Given** an authenticated `POST /api/scheduling` request  
**And** the body omits `reporterId`  
**And** the authenticated user's `id` does NOT correspond to a known admin (anomalous state — never happens for real sessions)  
**When** the request is processed  
**Then** the server MUST respond with HTTP 404  
**And** the body MUST contain a `code` mapped from `ReferenceNotFoundError('reporter', ...)` (same code used for an invalid explicit `reporterId`)

Rationale: documents the contract that the defaulted value goes through the same FK validation path as an explicit one. No special-casing.

---

### REQ-CREATE-12: `CreateTask` rejects a non-existent `projectId` with 404 PROJECT_NOT_FOUND

**Given** an authenticated `POST /api/scheduling` request
**And** the body contains a `projectId` that does NOT correspond to any existing Project
**When** the request is processed
**Then** the server MUST respond with HTTP 404
**And** the body MUST contain `{ "error": "<message>", "code": "PROJECT_NOT_FOUND" }`
**And** NO task MUST be persisted

#### Scenario

```
Given no Project with id 'fake-project-id' exists in the project lookup
When POST /api/scheduling with body { title: "T", priority: "normal", estimatedHours: 1,
     category: "repair", projectId: "fake-project-id", ... (all other required fields) }
Then response status is 404
And response body.code === 'PROJECT_NOT_FOUND'
And the task repository remains empty
```

---

### REQ-CREATE-13: `CreateTask` accepts a missing or null `projectId` without any project lookup

**Given** an authenticated `POST /api/scheduling` request
**And** the body omits `projectId` entirely OR sets it to `null`
**When** the request is processed
**Then** the server MUST respond with HTTP 201
**And** the created task's `projectId` MUST be `null`
**And** NO `EntityLookup<Project>` call MUST be made

#### Scenario A — omitted

```
Given a valid POST /api/scheduling body with no `projectId` key
When processed
Then response status is 201
And response body.projectId === null
```

#### Scenario B — explicit null

```
Given a valid POST /api/scheduling body with projectId: null
When processed
Then response status is 201
And response body.projectId === null
```

---

### REQ-CREATE-14: Empty-string `projectId` is coerced to `null` at the route level

**Rationale**: `CreateTaskBaseSchema.projectId` is `z.string().nullable().optional()` — it deliberately omits `.min(1)` (intentional asymmetry documented in the archive for `task-detail-reporter-and-unified-save`). An empty string `""` therefore passes Zod validation as a non-null, non-undefined string. Without coercion it would reach the project lookup with `id = ""`, trigger `ReferenceNotFoundError('project', '')`, and respond HTTP 404 — a spurious error that misleads the caller. The correct contract is that empty-string means "no project", identical to `null`. Coercion at the route level (before calling the use case) is the right seam, consistent with how other nullable fields are normalized in the POST handler (`data.projectId ?? null` already converts `undefined`; extend it to also coerce `""`).

**Given** an authenticated `POST /api/scheduling` request
**And** the body contains `projectId: ""`
**When** the request is processed
**Then** the server MUST respond with HTTP 201
**And** the created task's `projectId` MUST be `null`
**And** NO project lookup call MUST be made

**Given** an authenticated `PUT /api/scheduling/:id` request
**And** the body contains `projectId: ""`
**When** the request is processed
**Then** the server MUST respond with HTTP 200
**And** the updated task's `projectId` MUST be `null`

Coercion formula (route level, applied before passing data to the use case):
```ts
projectId: (data.projectId === '' ? null : data.projectId) ?? null
```

This applies identically to both the POST and PUT route handlers.

#### Scenario (POST)

```
Given valid POST body with projectId: ""
When processed
Then response status is 201
And response body.projectId === null
```

#### Scenario (PUT)

```
Given task 'task-1' exists
When PUT /api/scheduling/task-1 with body { projectId: "" }
Then response status is 200
And response body.projectId === null
```

---

## 5. Update Task

### REQ-UPDATE-1: Valid partial body updates task and returns 200

**Given** an authenticated `PUT /api/scheduling/:id` request  
**And** the task with the given `id` exists  
**And** the body is a valid `UpdateTaskSchema` object  
**When** the request is processed  
**Then** the server MUST respond with HTTP 200  
**And** the body MUST be the updated `ScheduledTask`

### REQ-UPDATE-2: Returns 404 when ID does not exist

**Given** an authenticated `PUT /api/scheduling/:id` request  
**And** no task with the given `id` exists  
**When** the request is processed  
**Then** the server MUST respond with HTTP 404  
**And** the body MUST contain `{ "code": "TASK_NOT_FOUND" }`

### REQ-UPDATE-3: Invalid field type in body returns 400

**Given** an authenticated `PUT /api/scheduling/:id` request  
**And** the body contains an invalid value (e.g. `estimatedHours: "not-a-number"`)  
**When** the request is processed  
**Then** the server MUST respond with HTTP 400  
**And** the body MUST contain `{ "code": "VALIDATION_ERROR" }`

### REQ-UPDATE-4: Invalid status in body returns 400

**Given** an authenticated `PUT /api/scheduling/:id` request  
**And** the body contains `status: "unknown_value"`  
**When** the request is processed  
**Then** the server MUST respond with HTTP 400  
**And** the body MUST contain `{ "code": "VALIDATION_ERROR" }`

---

### REQ-UPDATE-5: `UpdateTask` rejects a non-existent `projectId` with 404 PROJECT_NOT_FOUND

**Given** an authenticated `PUT /api/scheduling/:id` request
**And** the task with the given `id` exists
**And** the body contains a `projectId` that does NOT correspond to any existing Project
**When** the request is processed
**Then** the server MUST respond with HTTP 404
**And** the body MUST contain `{ "error": "<message>", "code": "PROJECT_NOT_FOUND" }`
**And** the task MUST NOT be modified

#### Scenario

```
Given a task with id 'task-1' exists
And no Project exists with id 'fake-project'
When PUT /api/scheduling/task-1 with body { projectId: 'fake-project' }
Then response status is 404
And response body.code === 'PROJECT_NOT_FOUND'
And task-1's projectId is unchanged
```

---

### REQ-UPDATE-6: `UpdateTask` accepts `projectId: null` (clears project assignment) without any lookup

**Given** an authenticated `PUT /api/scheduling/:id` request
**And** the task with the given `id` exists
**And** the body contains `projectId: null`
**When** the request is processed
**Then** the server MUST respond with HTTP 200
**And** the updated task's `projectId` MUST be `null`
**And** NO `EntityLookup<Project>` call MUST be made

#### Scenario

```
Given a task 'task-1' with projectId: 'project-abc'
When PUT /api/scheduling/task-1 with body { projectId: null }
Then response status is 200
And response body.projectId === null
```

---

### REQ-UPDATE-7: FK validation for `projectId` happens BEFORE Prisma persistence

**Given** an authenticated `PUT /api/scheduling/:id` request
**And** the body contains an invalid `projectId`
**When** `UpdateTask.execute` processes the data
**Then** `projectLookup.findById` MUST be called BEFORE `repo.updateTask` is called
**And** if the lookup fails, `repo.updateTask` MUST NOT be called
**And** the response MUST be HTTP 404 (never HTTP 500 from a Prisma FK violation)

This requirement formalises validation ordering: the canonical order is
`customer → service → partner → project → reporter → assignee → watchers`.

#### Scenario

```
Given a task 'task-1' exists
And no Project exists with id 'bad-id'
And a spy on repo.updateTask
When PUT /api/scheduling/task-1 with body { projectId: 'bad-id' }
Then projectLookup.findById('bad-id') is called
And repo.updateTask is NOT called
And response status is 404
```

---

## 6. Update Task Status

### REQ-STATUS-1: Valid status transition returns 200

**Given** an authenticated `PATCH /api/scheduling/:id/status` request  
**And** the task with the given `id` exists  
**And** the body contains `{ "status": "<valid-value>" }` where value is one of `pending | in_progress | completed | cancelled`  
**When** the request is processed  
**Then** the server MUST respond with HTTP 200  
**And** the body MUST be the updated `ScheduledTask` with the new `status`

### REQ-STATUS-2: Invalid status value returns 400

**Given** an authenticated `PATCH /api/scheduling/:id/status` request  
**And** the body contains `{ "status": "done" }` (not in the enum)  
**When** the request is processed  
**Then** the server MUST respond with HTTP 400  
**And** the body MUST contain `{ "code": "VALIDATION_ERROR" }`

### REQ-STATUS-3: Missing status field returns 400

**Given** an authenticated `PATCH /api/scheduling/:id/status` request  
**And** the body is `{}` (no `status` field)  
**When** the request is processed  
**Then** the server MUST respond with HTTP 400  
**And** the body MUST contain `{ "code": "VALIDATION_ERROR" }`

### REQ-STATUS-4: Status `completed` auto-sets `completedAt`

**Given** an authenticated `PATCH /api/scheduling/:id/status` request  
**And** the task with the given `id` exists and has `completedAt: null`  
**And** the body contains `{ "status": "completed" }`  
**When** the request is processed  
**Then** the server MUST respond with HTTP 200  
**And** the response body `completedAt` MUST be a non-null ISO 8601 timestamp  
**And** `completedAt` MUST represent the approximate time of the request (not a past value)

### REQ-STATUS-5: Non-completed status does not overwrite existing `completedAt`

**Given** an authenticated `PATCH /api/scheduling/:id/status` request  
**And** the task has `completedAt` already set  
**And** the body contains `{ "status": "in_progress" }`  
**When** the request is processed  
**Then** the server MUST respond with HTTP 200  
**And** the response `completedAt` MUST retain its original value (MUST NOT be overwritten to `null`)

### REQ-STATUS-6: Returns 404 when ID does not exist

**Given** an authenticated `PATCH /api/scheduling/:id/status` request  
**And** no task with the given `id` exists  
**When** the request is processed with a valid status  
**Then** the server MUST respond with HTTP 404  
**And** the body MUST contain `{ "code": "TASK_NOT_FOUND" }`

### REQ-STATUS-7: Response includes `projectName` when task has a linked project

**Given** an authenticated `PATCH /api/scheduling/:id/status` request  
**And** the task is linked to a project (`projectId` is set)  
**And** the body contains a valid `{ "status": "<value>" }`  
**When** the request is processed  
**Then** the response body `projectName` MUST be the name of the linked project (non-null string)  
**And** MUST NOT be `null` due to a missing `include: { project: true }` in the Prisma query

*Note: This is the explicit bug-fix scenario. The Prisma `updateTaskStatus` call MUST include `{ project: true }` in its `include` clause.*

---

## 7. Delete Task

### REQ-DELETE-1: Deleting an existing task returns 204

**Given** an authenticated `DELETE /api/scheduling/:id` request  
**And** the task with the given `id` exists  
**When** the request is processed  
**Then** the server MUST respond with HTTP 204  
**And** the response body MUST be empty

### REQ-DELETE-2: Deleting a non-existent task returns 404

**Given** an authenticated `DELETE /api/scheduling/:id` request  
**And** no task with the given `id` exists  
**When** the request is processed  
**Then** the server MUST respond with HTTP 404  
**And** the body MUST contain `{ "code": "TASK_NOT_FOUND" }`

---

## 8. Response Shape Consistency

### REQ-SHAPE-1: Every task response includes `projectName`

**Given** any authenticated request that returns a `ScheduledTask` (GET list, GET by id, POST, PUT, PATCH status)  
**When** the response is received  
**Then** every `ScheduledTask` in the response MUST include a `projectName` field  
**And** `projectName` MUST be a non-null string when the task is linked to a project  
**And** `projectName` MUST be `null` when the task has no linked project

### REQ-SHAPE-2: Task object field structure

Every `ScheduledTask` response object MUST contain at minimum the following fields:

| Field | Type | Nullable |
|-------|------|----------|
| `id` | `string` | No |
| `title` | `string` | No |
| `description` | `string \| null` | Yes |
| `assignedTo` | `string \| null` | Yes |
| `assignedToId` | `string \| null` | Yes |
| `clientId` | `string \| null` | Yes |
| `clientName` | `string \| null` | Yes |
| `serviceId` | `string` | No |
| `status` | `'pending' \| 'in_progress' \| 'completed' \| 'cancelled'` | No |
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
| `grOrdenId` | `string \| null` | Yes |

---

## 9. Nullable Fields Contract

### REQ-NULL-1: `description` MAY be `null` or a string

The API MUST accept and return `description` as `string | null`. The domain entity MUST declare this field as `string | null`. The Prisma adapter MUST map DB `null` to JS `null` (not `undefined`).

### REQ-NULL-2: `assignedTo` MAY be `null` or a string

The API MUST accept and return `assignedTo` as `string | null`.

### REQ-NULL-3: `assignedToId` MAY be `null` or a string

The API MUST accept and return `assignedToId` as `string | null`.

### REQ-NULL-4: `address` MAY be `null` or a string

The API MUST accept and return `address` as `string | null`.

### REQ-NULL-5: `notes` MAY be `null` or a string

The API MUST accept and return `notes` as `string | null`.

### REQ-NULL-6: `coordinates` MAY be `null`

The API MUST accept and return `coordinates` as `{ lat: number; lng: number } | null`.

### REQ-NULL-7: `clientId` and `clientName` MAY be `null`

The API MUST accept and return `clientId` and `clientName` as `string | null`.

### REQ-NULL-8: `projectId` and `projectName` MAY be `null`

The API MUST accept and return `projectId` and `projectName` as `string | null` when a task has no linked project.

### REQ-NULL-9: Prisma adapter MUST NOT return `undefined` for nullable fields

**Given** a DB row where any of the above nullable fields is `NULL`  
**When** `PrismaSchedulingRepository.toTask` maps the row to a `ScheduledTask`  
**Then** each nullable field MUST be `null` in the resulting object (not `undefined`)  
**And** the mapper MUST use `?? null` (not `?? undefined`) for all nullable fields

---

## 10. Validation Schemas

### REQ-VAL-1: `CreateTaskSchema` covers all required fields

The schema MUST require: `title`, `status`, `priority`, `scheduledDate`, `scheduledTime`, `estimatedHours`, `category`, `serviceId`.  
`serviceId` MUST be `z.string().min(1)` — NOT `.nullable().optional()`.  
The schema MUST allow (nullable/optional): `description`, `assignedTo`, `assignedToId`, `address`, `notes`, `clientId`, `clientName`, `coordinates`, `projectId`, `completedAt`.  
The `status` field MUST be restricted to `z.enum(['pending', 'in_progress', 'completed', 'cancelled'])`.  
The `priority` field MUST be restricted to `z.enum(['low', 'normal', 'high', 'urgent'])`.  
The `category` field MUST be restricted to `z.enum(['installation', 'repair', 'maintenance', 'inspection', 'other'])`.

### REQ-VAL-2: `UpdateTaskSchema` is a partial of `CreateTaskSchema`

All fields MUST be optional. Enum restrictions on `status`, `priority`, and `category` MUST still apply when those fields are present.  
`serviceId` MUST remain optional in `UpdateTaskSchema` (patch semantics — no change to update behavior).

### REQ-VAL-3: `UpdateStatusSchema` only accepts the 4 valid status values

The schema MUST require a single field `status` of type `z.enum(['pending', 'in_progress', 'completed', 'cancelled'])`.  
Any value outside this enum MUST cause a 400 response with `code: 'VALIDATION_ERROR'`.

---

## 11. CreateTask Use Case — serviceId Constraint

### REQ-UC-SERVICE-1: `serviceId` validation is unconditional

**Given** `CreateTask.execute` is called with a `CreateTaskInput`  
**And** `serviceId` is always present (required field, never null)  
**When** executing the FK validation block  
**Then** `serviceLookup.findById(data.serviceId)` MUST be called without a null guard  
**And** if not found, MUST throw `ReferenceNotFoundError('service', data.serviceId)`

*Note: The previous `if (data.serviceId != null)` guard MUST be removed.*

---

## 13. Dependency Inversion Preservation

### REQ-DIP-1: No `@infrastructure/*` imports in application layer

The `application/dto/scheduling.dto.ts` file MUST NOT import from `@infrastructure/*`.  
Use cases (`ListTasks`, `GetTask`, `CreateTask`, `UpdateTask`, `DeleteTask`, `UpdateTaskStatus`) MUST NOT import from `@infrastructure/*`.  
This constraint is verified by `tsc --noEmit` and enforced by path alias configuration.

### REQ-DIP-2: `createSchedulingRouter` receives `authProvider` as a parameter

The router factory function MUST accept `authProvider: JwtAuthAdapter` as an additional parameter (after the existing use-case parameters).  
It MUST NOT construct or import a concrete `JwtAuthAdapter` internally.

---

## 14. Reference Infrastructure

### REQ-REF-1: `ReferenceKind` includes `'project'` and `REFERENCE_TO_CODE` maps it to `'PROJECT_NOT_FOUND'`

**Given** the domain type `ReferenceKind` (in `src/domain/errors/scheduling.ts`)
**And** the route-level map `REFERENCE_TO_CODE` (in `src/infrastructure/http/routes/scheduling.routes.ts`)
**Then** `ReferenceKind` MUST include the literal `'project'`
**And** `REFERENCE_TO_CODE['project']` MUST equal `'PROJECT_NOT_FOUND'`
**And** the global `errorHandler` already maps `PROJECT_NOT_FOUND` → HTTP 404 (no change needed there)

This requirement ensures the error chain is fully wired:
`ReferenceNotFoundError('project', id)` → caught in route → `REFERENCE_TO_CODE['project']` → `'PROJECT_NOT_FOUND'` → HTTP 404.

---

## 15. Reference Infrastructure — `service` kind

### REQ-REF-SERVICE-1: `ReferenceKind` includes `'service'` and `REFERENCE_TO_CODE` maps it

**Given** the domain type `ReferenceKind` (in `src/domain/errors/scheduling.ts`)  
**And** the route-level map `REFERENCE_TO_CODE` (in `src/infrastructure/http/routes/scheduling.routes.ts`)  
**Then** `ReferenceKind` MUST include the literal `'service'`  
**And** `REFERENCE_TO_CODE['service']` MUST map to an appropriate error code (e.g. `'REFERENCE_NOT_FOUND'` or `'SERVICE_NOT_FOUND'`)  
**And** the route handler MUST respond HTTP 422 or 404 accordingly

---

## Appendix: Enum Reference

| Type | Values |
|------|--------|
| `TaskStatus` | `pending`, `in_progress`, `completed`, `cancelled` |
| `TaskPriority` | `low`, `normal`, `high`, `urgent` |
| `category` | `installation`, `repair`, `maintenance`, `inspection`, `other` |

## Appendix: Error Response Format

All error responses MUST follow this shape:

```json
{
  "error": "<human-readable message>",
  "code": "<machine-readable code>",
  "details": "<optional, zod validation details>"
}
```

| Scenario | HTTP Status | `code` |
|----------|-------------|--------|
| No/invalid `auth_token` cookie | 401 | `UNAUTHORIZED` |
| JWT verification fails | 401 | `UNAUTHORIZED` or `AuthenticationError.code` |
| Zod validation failure | 400 | `VALIDATION_ERROR` |
| Task ID not found | 404 | `TASK_NOT_FOUND` |

---

# Delta absorbido: task-send-to-iclass (2026-05-27)


## Modified Requirements

### REQ-MOVE-STAGE-1: Mover al stage "Enviar a IClass" dispara el alta de OS (MODIFIED)

Cuando una tarea se mueve a un stage cuyo nombre es **"Enviar a IClass"**, el comportamiento depende del flag `iclass-integration`:

- Flag **OFF** → la tarea se mueve al stage normalmente (200), SIN llamar a IClass.
- Flag **ON** → antes de mover, se valida y se crea la OS (ver REQ-MOVE-VAL-1, REQ-MOVE-OS-1).

Mover a cualquier OTRO stage MUST conservar el comportamiento actual (sin cambios).

Se agrega un campo opcional `iclassOrderCode: string | null` a la respuesta de `ScheduledTask` (poblado tras un alta exitosa; `null` en cualquier otro caso).

---

## Added Requirements

### REQ-MOVE-VAL-1: Validación de campos requeridos (para el modal del front)

Los campos requeridos para enviar a IClass son: **`customerName`, `phone`, `address`, `city`, `description`**.
Origen: `customerName`/`phone`/`city` desde el `Client` referenciado por `customerId`; `address`/`description` desde la tarea.

#### Scenario: Falta uno o más requeridos → 422 con missingFields

**Given** un `PATCH /api/scheduling/:id/stage` al stage "Enviar a IClass"
**And** el flag `iclass-integration` está ON
**And** la tarea no tiene `phone` ni `description`
**When** se procesa
**Then** MUST responder 422 con `{ code: "MISSING_REQUIRED_FIELDS", missingFields: ["phone", "description"] }`
**And** la tarea NO MUST cambiar de stage
**And** NO MUST crearse ninguna OS en IClass

#### Scenario: La tarea sin `customerId` reporta customerName/phone/city faltantes

**Given** una tarea con `customerId: null`
**When** se intenta mover a "Enviar a IClass" con el flag ON
**Then** MUST responder 422 con `missingFields` incluyendo `customerName`, `phone`, `city`

#### Scenario: Ciudad sin nodo válido en IClass → 422

**Given** todos los requeridos presentes
**And** `city` no matchea ningún nodo de IClass (REQ-OS-2)
**When** se procesa
**Then** MUST responder 422 con `{ code: "ICLASS_NODE_NOT_FOUND" }`
**And** la tarea NO MUST cambiar de stage

### REQ-MOVE-OS-1: Alta exitosa mueve a "Registrado en IClass"

#### Scenario: Datos válidos crean la OS y avanzan el stage

**Given** un `PATCH /api/scheduling/:id/stage` al stage "Enviar a IClass"
**And** el flag está ON y todos los requeridos son válidos (incluida ciudad con nodo)
**When** se procesa
**Then** MUST crearse la OS vía `IClassPort.createServiceOrder` (sin fecha)
**And** la tarea MUST quedar en el stage **"Registrado en IClass"** (NO en "Enviar a IClass")
**And** la respuesta MUST incluir `iclassOrderCode` con el código devuelto por IClass
**And** la respuesta MUST ser 200

#### Scenario: IClass no disponible no avanza el stage

**Given** los requeridos válidos pero IClass falla (REQ-OS-3)
**When** se procesa
**Then** MUST responder 502 con `{ code: "ICLASS_UNAVAILABLE" }`
**And** la tarea NO MUST cambiar de stage
**And** `iclassOrderCode` MUST permanecer `null`

### REQ-MOVE-FLAG-OFF-1: Con el flag apagado el alta se omite

#### Scenario: Flag OFF mueve sin tocar IClass

**Given** el flag `iclass-integration` en OFF
**And** un `PATCH /api/scheduling/:id/stage` al stage "Enviar a IClass" (aunque falten requeridos)
**When** se procesa
**Then** MUST responder 200 y la tarea MUST quedar en "Enviar a IClass"
**And** NO MUST llamarse a IClass ni validarse requeridos

---

---

## SO Type Resolution from Project Mapping (iclass-so-type-mapping change)

As of the `iclass-so-type-mapping` change, `SendTaskToIClass` resolves `soType` deterministically from the task's project. Two new domain errors cover missing mappings.

### REQ-SCHED-ERR-1: `MissingProjectForIClassError`

A new domain error MUST exist in `src/domain/errors/`:

```ts
class MissingProjectForIClassError extends Error {
  readonly code = 'MISSING_PROJECT_FOR_ICLASS';
  constructor(taskId: string) { ... }
}
```

The HTTP handler MUST map this to HTTP 422 with `{ code: "MISSING_PROJECT_FOR_ICLASS" }`.

#### Scenario: Task without project is rejected

**Given** a task `t-1` with `projectId: null`
**And** the `iclass-integration` flag is ON
**When** the stage-move endpoint is called for stage "Enviar a IClass"
**Then** the server MUST respond HTTP 422 with `{ code: "MISSING_PROJECT_FOR_ICLASS" }`
**And** the task MUST remain in its current stage

### REQ-SCHED-ERR-2: `MissingIClassMappingError`

A new domain error MUST exist:

```ts
class MissingIClassMappingError extends Error {
  readonly code = 'MISSING_ICLASS_MAPPING';
  readonly projectTitle: string;
  constructor(projectTitle: string) { ... }
}
```

The HTTP handler MUST map this to HTTP 422 with `{ code: "MISSING_ICLASS_MAPPING", projectTitle: "<title>" }`.

**Design decision — single error for inactive mapping**: An inactive `iclassSoTypeId` on the project at send-time is treated as a missing mapping and MUST throw `MissingIClassMappingError` (not a separate error). Rationale: from the operator's perspective both cases require the same corrective action — go to the Project and set/fix the IClass mapping.

#### Scenario: Project without mapping is rejected

**Given** a task `t-1` linked to project `p-1` (title: "Cableado Norte")
**And** `p-1.iclassSoTypeId: null`
**And** the `iclass-integration` flag is ON
**When** the stage-move endpoint is called for "Enviar a IClass"
**Then** the server MUST respond HTTP 422 with `{ code: "MISSING_ICLASS_MAPPING", projectTitle: "Cableado Norte" }`
**And** the task MUST remain in its current stage

### REQ-SCHED-1: Task must have a project for IClass send

**Given** a task with `projectId: null`
**And** the `iclass-integration` flag is ON
**When** `SendTaskToIClass.execute` is called
**Then** the use case MUST throw `MissingProjectForIClassError`
**And** NO call to `IClassPort` MUST be made
**And** the task stage MUST NOT change

### REQ-SCHED-2: Project must have an `iclassSoTypeId` set to an ACTIVE type

**Given** a task linked to project `p-1`
**And** `p-1.iclassSoTypeId` is `null` OR `p-1.iclassSoType.active` is `false`
**And** the flag is ON
**When** `SendTaskToIClass.execute` is called
**Then** the use case MUST throw `MissingIClassMappingError` with `projectTitle` equal to `p-1.title`
**And** NO call to `IClassPort` MUST be made

#### Scenario: Project with inactive type is rejected

**Given** a task `t-1` linked to project `p-1` (title: "Mantenimiento Sur")
**And** `p-1.iclassSoType: { code: "OLD_TYPE", active: false }`
**And** the flag is ON
**When** the stage-move endpoint is called for "Enviar a IClass"
**Then** the server MUST respond HTTP 422 with `{ code: "MISSING_ICLASS_MAPPING", projectTitle: "Mantenimiento Sur" }`

### REQ-SCHED-3: Valid mapping passes `soType` to `IClassPort.createServiceOrder`

**Given** a task `t-1` linked to project `p-1`
**And** `p-1.iclassSoType: { code: "INSTALACION FIBRA", active: true }`
**And** all 5 required fields (customerName, phone, address, city, description) are present
**And** the flag is ON
**When** `SendTaskToIClass.execute` is called
**Then** `IClassPort.createServiceOrder` MUST be called with `soType: "INSTALACION FIBRA"` in the input
**And** the task MUST advance to "Registrado en IClass" upon success

### REQ-SCHED-4: soType resolution is skipped when flag is OFF

**Given** the `iclass-integration` flag is OFF
**And** a task has `projectId: null`
**When** `SendTaskToIClass.execute` is called
**Then** the task MUST move to the target stage normally (no soType check, no IClass call)
**And** MUST NOT throw `MissingProjectForIClassError`

### REQ-SCHED-5: `SchedulingRepository.getTask` MUST include project with iclassSoType

**Given** a task with a linked project
**When** `SchedulingRepository.getTask(taskId)` is called
**Then** the returned `ScheduledTask` MUST include:
  - `projectId: string | null`
  - `project: { id, title, iclassSoTypeId, iclassSoType: { id, code, description, active } | null } | null`

The repository MUST eager-load the project and its `iclassSoType` relation in the same call. The use case MUST NOT issue a separate lookup for the project.

---

## Appendix: New Error Codes

| Scenario | HTTP | `code` | Extra Fields |
|----------|------|--------|--------------|
| Faltan requeridos | 422 | `MISSING_REQUIRED_FIELDS` (+ `missingFields[]`) | — |
| Ciudad sin nodo IClass | 422 | `ICLASS_NODE_NOT_FOUND` | — |
| Task sin Project | 422 | `MISSING_PROJECT_FOR_ICLASS` | — |
| Project sin mapping o tipo inactivo | 422 | `MISSING_ICLASS_MAPPING` | `projectTitle` |
| IClass no disponible | 502 | `ICLASS_UNAVAILABLE` | — |

---

# Delta absorbido: task-requires-service (2026-05-30)

**Change**: `task-requires-service`  
**Routes affected**: `POST /api/scheduling` (create task only)

## Summary

`serviceId` transitions from optional-nullable to **required** in the create path. The DB column `ScheduledTask.serviceId` stays `String?` (nullable, `onDelete: SetNull`) — the constraint is enforced at the application layer only.

## Modified

- **REQ-VAL-1**: `serviceId` added to required fields in `CreateTaskSchema` as `z.string().min(1)`.
- **REQ-VAL-2**: `serviceId` remains optional in `UpdateTaskSchema` (patch semantics unchanged).
- **REQ-SHAPE-2**: `serviceId` added as non-nullable field in task response shape.
- **Sections 11, 14, 15**: Added REQ-CREATE-SERVICE-1–5 (HTTP-level), REQ-UC-SERVICE-1 (use case), REQ-REF-SERVICE-1 (ReferenceKind).

## Non-Goals (explicitly excluded from this delta)

- `PUT /api/scheduling/:id` update path — `serviceId` remains optional for edits.
- `GET`, `DELETE`, `PATCH /:id/status` — unchanged.
- DB schema migration — column stays nullable.
- Backfilling existing tasks with a `serviceId`.

---

## Closure loop integration (iclass-closure-loop)

ADDED: `ScheduledTask` gana la relación inversa `iclassClosedOrder` (one-to-one nullable) hacia `IClassServiceOrder`. `SchedulingRepository` gana `findTaskBySequenceNumber` (join codigo↔sequenceNumber del cierre) y `listTasksInIClassStage` (backfill). Una tarea PUEDE moverse de stage por el closure loop al estado mapeado en `IClassResultCode.mappedStageId`, vía el `moveTaskToStage` existente. Ver capability `iclass-closure-loop`.

---

## GR installation ingest integration (gestion-real-installation-ingest)

The Gestión Real installation ingest creates `ScheduledTask`s programmatically (one per pending CI
order). This adds an idempotency key (`grOrdenId`) and formalizes that an ingest-created task MAY
exist with no project (needs-review state). No existing route behavior changes. See capabilities
`gestion-real-ingest` and `gestion-real-ingest-config`.

### Requirement: `ScheduledTask` carries a unique `grOrdenId` idempotency key

`ScheduledTask` MUST have a `grOrdenId: string | null` field, persisted as a UNIQUE, NULLABLE
column via an ADDITIVE Prisma migration. It holds the Gestión Real order id for tasks created by
the ingest engine; manually created tasks leave it `null`. The uniqueness constraint MUST allow
multiple `null` rows (standard SQL NULL-distinct behavior) so that hand-made tasks are unaffected.
(See REQ-SHAPE-2 — the `grOrdenId: string | null` row is part of the task object structure.)

#### Scenario: Ingest-created task stores the GR order id

- GIVEN the ingest creates a task for GR order `551`
- WHEN the task is persisted
- THEN `grOrdenId` equals `"551"`

#### Scenario: Manually created task has null grOrdenId

- GIVEN a `POST /api/scheduling` request that does not set `grOrdenId`
- WHEN the task is created
- THEN the persisted task's `grOrdenId` is `null`

#### Scenario: Duplicate grOrdenId is rejected at the DB level

- GIVEN a task already exists with `grOrdenId = "551"`
- WHEN a second task with `grOrdenId = "551"` is attempted
- THEN the unique constraint prevents a duplicate (the ingest checks first and skips — see REQ-IDEMP-1 in gestion-real-ingest)

### Requirement: A `ScheduledTask` MAY be created with no project (needs-review state)

The ingest engine MAY create a `ScheduledTask` with `projectId = null` (the UNCLASSIFIED /
needs-review case). Such a task MUST be valid and persistable. Its `projectName` MUST serialize as
`null` (consistent with the existing nullable-project contract, REQ-NULL-8 / REQ-SHAPE-1).

#### Scenario: Needs-review task persists with null project

- GIVEN the ingest classifies an order as UNCLASSIFIED
- WHEN the task is created
- THEN the task persists with `projectId = null` and `projectName = null`
- AND no `PROJECT_NOT_FOUND` error is raised (no project lookup for a null id)

---

# Delta absorbido: scheduling-foundation-stage-model (2026-05-30)

Moves `scheduling` from a hardcoded 4-value `status` enum to a configurable `Workflow + Stage`
model. The new `Workflow`/`Stage` admin surface lives in the `scheduling-workflows` capability.
The legacy `status` field/route is retained as a DEPRECATED shim for one release.

## Removed Requirements

- **REQ-STATUS-1/2/3** — Replaced by REQ-STAGE-1/2/3 (move to stage). The `/status` PATCH endpoint
  persists only as a deprecated alias (REQ-STAGE-DEP-1..3).
- **REQ-VAL-3 (`UpdateStatusSchema`)** — Marked `@deprecated`; constraint applies to the deprecated
  route only.
- **REQ-VAL-1 / REQ-VAL-2 — `status` as a writable field** — Removed. `status` is no longer writable
  on Create/Update; it appears in responses only as a derived deprecated alias.
- **REQ-SHAPE-2 `status` row** as a non-nullable writable enum — Superseded by `stageId` +
  `stageCategory` (derived) + deprecated `status`.

## Modified Requirements

### REQ-CREATE-1 (modified): `status` not required; `stageId` optional
`status` MUST NOT be required on `POST /api/scheduling`. The body MAY include `stageId: string`.
When omitted, the task defaults to the first `nuevo`-category Stage of the Default workflow.

### REQ-CREATE-4 (modified): Invalid stageId returns 404 / malformed returns 400
Non-existent well-formed `stageId` → 404 `STAGE_NOT_FOUND`. Non-string `stageId` → 400
`VALIDATION_ERROR`.

### REQ-UPDATE-4 (modified): Invalid stageId in PUT body returns 400/404
Malformed `stageId` → 400 `VALIDATION_ERROR`; well-formed non-existent → 404 `STAGE_NOT_FOUND`.

### REQ-SHAPE-2 (modified): Task object adds `stageId` + `stageCategory`
Every `ScheduledTask` response MUST carry `stageId: string` (non-null) and
`stageCategory: 'nuevo' | 'enProgreso' | 'hecho'` (non-null, derived). The legacy
`status: 'pending' | 'in_progress' | 'completed' | 'cancelled'` row is RETAINED as DEPRECATED
(derived) for one release.

### REQ-VAL-1 (modified): `CreateTaskSchema` drops `status`, adds `stageId`
Required: `title`, `priority`, `scheduledDate`, `scheduledTime`, `estimatedHours`, `category`.
`stageId` MUST be `z.string().uuid().optional()`. `status` MUST NOT appear.

### REQ-VAL-2 (modified): `UpdateTaskSchema` partial; `status` removed
All fields optional; `stageId` validated as in create; `status` MUST NOT appear.

## Added Requirements

### REQ-STAGE-1: Move task to stage returns 200
`PATCH /api/scheduling/:id/stage` with `{ stageId }` referencing an existing Stage → 200 with the
updated task; `stageId` echoed, `stageCategory` equals the referenced Stage's `category`.

### REQ-STAGE-2: Non-existent stageId returns 404 `STAGE_NOT_FOUND`.

### REQ-STAGE-3: Missing/malformed stageId returns 400 `VALIDATION_ERROR`.

### REQ-STAGE-4: Task not found returns 404 `TASK_NOT_FOUND`.

### REQ-STAGE-CATEGORY-1: `stageCategory` is derived from the Stage and is NOT writable.

### REQ-STAGE-COMPLETED-1: Moving to a `hecho`-category stage auto-sets `completedAt` (ISO 8601 ~now)
when it was `null`.

### REQ-STAGE-COMPLETED-2: Moving to a non-`hecho` stage does NOT overwrite an existing `completedAt`.

### REQ-STAGE-PROJECTNAME-1: Stage-move response includes `projectName` for a linked-project task.

### REQ-STAGE-DEFAULT-1: Create without `stageId` defaults to the Default workflow's lowest-`order`
`nuevo` Stage; `stageCategory` MUST be `'nuevo'`.

### Deprecation Aliases (one release only)

- **REQ-STAGE-DEP-1**: `PATCH /:id/status` keeps working, translating legacy `status` to the Default
  workflow Stage: `pending→"Nuevo"`, `in_progress→"En progreso"`, `completed→"Hecho"`,
  `cancelled→"Anulado-Cancelado"`. Same `completedAt` semantics as `/stage`.
- **REQ-STAGE-DEP-2**: The deprecated route MUST emit a `console.warn`/structured log containing
  `"deprecated"` and the route name (no HTTP change).
- **REQ-STAGE-DEP-3**: Responses include a derived `status` (reverse mapping). For Stages outside the
  Default workflow, `status` is the closest match by `stageCategory`:
  `nuevo→'pending'`, `enProgreso→'in_progress'`, `hecho→'completed'` (or `'cancelled'` if the Stage
  name contains `"cancel"`/`"anul"`, case-insensitive).

## Appendix updates

| Type | Values | Status |
|------|--------|--------|
| `TaskStatus` | `pending`, `in_progress`, `completed`, `cancelled` | **Deprecated** — legacy response field only, not writable |
| `StageCategory` | `nuevo`, `enProgreso`, `hecho` | New — read-only derived response field |

| Scenario | HTTP | `code` |
|----------|------|--------|
| Stage ID not found | 404 | `STAGE_NOT_FOUND` |

---

# Delta absorbido: scheduling-tasks-enrich (2026-05-30)

Enriches `ScheduledTask` with date-range, customer/service/partner/reporter/assignee FKs, watchers,
and travel times. Legacy fields (`scheduledDate`, `scheduledTime`, `clientId`, `clientName`,
`assignedTo`, `assignedToId`, `status`) stay as DEPRECATED read-only for one release. No new routes.

## Modified Requirements

### REQ-SHAPE-2 (modified): Task object adds enrichment fields
Added (all nullable unless noted): `startDate`, `endDate` (ISO 8601 with offset), `customerId`,
`customerName` (JOIN-derived), `serviceId`, `partnerId`, `reporterId`, `assigneeId`, `assigneeName`
(JOIN-derived), `watcherIds: string[]` (non-null, `[]` when none), `travelTimeTo`, `travelTimeFrom`
(integer minutes). Legacy fields listed above stay present, typed as before, marked DEPRECATED.

### REQ-NULL-7 (modified): `clientId`/`clientName`/`customerId`/`customerName` all `string | null`
When `customerId` is set, the adapter MUST populate `customerName` from `Client.name`. Legacy
`clientName` MAY come from the deprecated column or the same JOIN.

### REQ-VAL-1 (modified): `CreateTaskSchema` required set narrows; enrichment fields added
Required: `title`, `priority`, `estimatedHours`, `category` (`scheduledDate`/`scheduledTime`/`status`
no longer required). Adds optional/nullable: `startDate`/`endDate`
(`z.string().datetime({ offset: true }).nullable().optional()`),
`customerId`/`serviceId`/`partnerId`/`reporterId`/`assigneeId`
(`z.string().min(1).nullable().optional()` — NOT `.uuid()`),
`watcherIds` (`z.array(z.string().min(1)).optional()`),
`travelTimeTo`/`travelTimeFrom` (`z.number().int().nonnegative().nullable().optional()`).
A `superRefine` MUST reject `endDate < startDate` with `VALIDATION_ERROR` and a `details` entry on
`endDate`.

### REQ-CREATE-1 / REQ-UPDATE-1 (modified): FK validation + JOIN-resolved names
FK references in the body MUST be validated in the use case (REQ-CUSTOMER-1, REQ-WATCHER-1).
Responses echo the new fields and resolve `customerName`/`assigneeName` via JOIN. On PUT, when
`watcherIds` is present the set is replaced atomically; when omitted it is untouched.

## Added Requirements

### REQ-DATETIME-1: `startDate`/`endDate` contract
Valid ISO 8601 round-trips (offset normalization OK); `endDate < startDate` → 400; either MAY be
`null`; malformed strings → 400 `VALIDATION_ERROR`.

### REQ-CUSTOMER-1: FK validation for `customerId` (and `serviceId`/`partnerId`/`reporterId`/`assigneeId`)
Non-existent reference → 404 with `CUSTOMER_NOT_FOUND` / `SERVICE_NOT_FOUND` / `PARTNER_NOT_FOUND` /
`REPORTER_NOT_FOUND` / `ASSIGNEE_NOT_FOUND`. Existing `customerId` resolves `customerName` via JOIN.

### REQ-WATCHER-1: Watchers replace-set semantics
`watcherIds` authoritative when present; `[]` clears; omitted preserves; any non-existent id rejects
the whole update with 404 `WATCHER_NOT_FOUND` (atomic — no partial update).

### REQ-TRAVEL-1: Travel-time bounds
Non-negative integers accepted; negative or non-integer → 400 `VALIDATION_ERROR`; `null` accepted.

### REQ-RICH-DESC-1: Rich-text `description` stored/returned as-is
HTML and plain text round-trip unchanged. **Non-goal**: server-side XSS sanitization — consumers
render through DOMPurify.

### REQ-FK-ORDER-1: FK validation is deterministic
Canonical order: `customerId → serviceId → partnerId → reporterId → assigneeId → watcherIds[*]`. The
first missing reference determines the error code.

### REQ-DEPRECATED-1: Legacy fields still returned alongside new fields
During the deprecation window both sets are present; the new fields are authoritative, legacy fields
are best-effort fallbacks.

## Appendix: New Error Codes

| Scenario | HTTP | `code` |
|----------|------|--------|
| Non-existent `customerId` | 404 | `CUSTOMER_NOT_FOUND` |
| Non-existent `serviceId` | 404 | `SERVICE_NOT_FOUND` |
| Non-existent `partnerId` | 404 | `PARTNER_NOT_FOUND` |
| Non-existent `reporterId` | 404 | `REPORTER_NOT_FOUND` |
| Non-existent `assigneeId` | 404 | `ASSIGNEE_NOT_FOUND` |
| Non-existent `watcherIds[i]` | 404 | `WATCHER_NOT_FOUND` |
| `endDate < startDate` / bad travel time / malformed date | 400 | `VALIDATION_ERROR` |

---

# Delta absorbido: task-rv-inventory (2026-05-30)

Adds a boolean `reviewedByInventory` flag to `ScheduledTask`, driving the "RV" (Revisado por
Inventario) column in the task list UI.

## Added Requirements

### REQ-RV-1: Schema field
`ScheduledTask` DB row MUST have `reviewedByInventory Boolean @default(false)`. New rows default to
`false`; existing rows backfilled to `false` via migration default.

### REQ-RV-2: Domain entity field
`ScheduledTask` interface MUST expose `reviewedByInventory: boolean`, present on every task returned
from the API.

### REQ-RV-3: Port method
`SchedulingRepository.setInventoryReview(taskId: string, reviewed: boolean): Promise<ScheduledTask | null>`
(returns `null` when the task is not found).

### REQ-RV-4: Use case
`SetTaskInventoryReview` accepts `(taskId, reviewed)`, delegates to `repo.setInventoryReview`,
returns the updated task, and throws `TaskNotFoundError` when the task does not exist.

### REQ-RV-5: HTTP endpoint
`PATCH /api/scheduling/:id/inventory-review` with `{ "reviewed": boolean }` (cookie auth):
- 200 + updated task DTO on success.
- 400 `VALIDATION_ERROR` for an invalid body.
- 404 `TASK_NOT_FOUND` when the task does not exist.

### REQ-RV-6: Existing responses carry the flag
All endpoints returning `ScheduledTask` (GET list/single, POST, PUT, PATCH stage) MUST include
`reviewedByInventory`. New tasks default to `false`; the flag persists through unrelated updates.
