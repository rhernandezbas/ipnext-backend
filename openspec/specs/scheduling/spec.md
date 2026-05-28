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

The schema MUST require: `title`, `status`, `priority`, `scheduledDate`, `scheduledTime`, `estimatedHours`, `category`.  
The schema MUST allow (nullable/optional): `description`, `assignedTo`, `assignedToId`, `address`, `notes`, `clientId`, `clientName`, `coordinates`, `projectId`, `completedAt`.  
The `status` field MUST be restricted to `z.enum(['pending', 'in_progress', 'completed', 'cancelled'])`.  
The `priority` field MUST be restricted to `z.enum(['low', 'normal', 'high', 'urgent'])`.  
The `category` field MUST be restricted to `z.enum(['installation', 'repair', 'maintenance', 'inspection', 'other'])`.

### REQ-VAL-2: `UpdateTaskSchema` is a partial of `CreateTaskSchema`

All fields MUST be optional. Enum restrictions on `status`, `priority`, and `category` MUST still apply when those fields are present.

### REQ-VAL-3: `UpdateStatusSchema` only accepts the 4 valid status values

The schema MUST require a single field `status` of type `z.enum(['pending', 'in_progress', 'completed', 'cancelled'])`.  
Any value outside this enum MUST cause a 400 response with `code: 'VALIDATION_ERROR'`.

---

## 11. Dependency Inversion Preservation

### REQ-DIP-1: No `@infrastructure/*` imports in application layer

The `application/dto/scheduling.dto.ts` file MUST NOT import from `@infrastructure/*`.  
Use cases (`ListTasks`, `GetTask`, `CreateTask`, `UpdateTask`, `DeleteTask`, `UpdateTaskStatus`) MUST NOT import from `@infrastructure/*`.  
This constraint is verified by `tsc --noEmit` and enforced by path alias configuration.

### REQ-DIP-2: `createSchedulingRouter` receives `authProvider` as a parameter

The router factory function MUST accept `authProvider: JwtAuthAdapter` as an additional parameter (after the existing use-case parameters).  
It MUST NOT construct or import a concrete `JwtAuthAdapter` internally.

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
