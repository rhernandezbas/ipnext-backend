# Spec: Projects Capability

**Capability**: `projects`
**Type**: New (no prior spec exists for this capability)
**Change**: `scheduling-projects-enrich`
**Routes**: `GET /api/projects`, `GET /api/projects/:id`, `POST /api/projects`, `PUT /api/projects/:id`, `DELETE /api/projects/:id`

---

## 1. Authentication

All 5 project routes MUST enforce authentication via the `auth_token` cookie using `createAuthMiddleware(authProvider)`. This closes a pre-existing security gap where the routes were mounted without middleware.

### REQ-AUTH-1: Missing cookie is rejected on GET /

**Given** a request to `GET /api/projects` without an `auth_token` cookie
**When** the request is received
**Then** the server MUST respond with HTTP 401
**And** the body MUST contain `{ "code": "UNAUTHORIZED" }`
**And** the response MUST NOT include any project data

### REQ-AUTH-2: Missing cookie is rejected on GET /:id

**Given** a request to `GET /api/projects/<any-id>` without an `auth_token` cookie
**When** the request is received
**Then** the server MUST respond with HTTP 401
**And** the body MUST contain `{ "code": "UNAUTHORIZED" }`

### REQ-AUTH-3: Missing cookie is rejected on POST /

**Given** a request to `POST /api/projects` without an `auth_token` cookie
**When** the request is received with a valid body
**Then** the server MUST respond with HTTP 401
**And** the body MUST contain `{ "code": "UNAUTHORIZED" }`

### REQ-AUTH-4: Missing cookie is rejected on PUT /:id

**Given** a request to `PUT /api/projects/<any-id>` without an `auth_token` cookie
**When** the request is received with a valid body
**Then** the server MUST respond with HTTP 401

### REQ-AUTH-5: Missing cookie is rejected on DELETE /:id

**Given** a request to `DELETE /api/projects/<any-id>` without an `auth_token` cookie
**Then** the server MUST respond with HTTP 401

### REQ-AUTH-6: Invalid token is rejected

**Given** any project route called with an `auth_token` cookie whose value cannot be verified
**When** the request is received
**Then** the server MUST respond with HTTP 401
**And** the body MUST contain a `code` field (either `"UNAUTHORIZED"` or `AuthenticationError.code`)

### REQ-AUTH-7: Valid token is forwarded to the handler

**Given** a request to any project route with a valid `auth_token` cookie
**When** `authProvider.getSession` resolves a `User` object
**Then** the server MUST call the next handler
**And** MUST NOT respond with 401

---

## 2. List Projects

### REQ-LIST-1: Returns array of projects with derived counts

**Given** an authenticated `GET /api/projects` request
**When** the repository contains projects
**Then** the server MUST respond with HTTP 200
**And** the body MUST be a JSON array of `Project` objects
**And** every element MUST include `taskCounts: { nuevo: number, enProgreso: number, hecho: number, total: number }`

### REQ-LIST-2: taskCounts derived from Stage.category

**Given** an authenticated `GET /api/projects` request
**And** a project has linked tasks whose `stage.category` values are `nuevo | enProgreso | hecho`
**When** the response is returned
**Then** `taskCounts.nuevo` MUST equal the count of tasks whose `stage.category = 'nuevo'`
**And** `taskCounts.enProgreso` MUST equal the count where `category = 'enProgreso'`
**And** `taskCounts.hecho` MUST equal the count where `category = 'hecho'`
**And** `taskCounts.total` MUST equal the total number of linked tasks
**And** these counts MUST NOT be derived from the deprecated `ScheduledTask.status` column

### REQ-LIST-3: Empty list returns empty array

**Given** an authenticated `GET /api/projects` request
**When** no projects exist
**Then** the server MUST respond with HTTP 200 and body `[]`

### REQ-LIST-4: Visible filter (optional)

**Given** an authenticated `GET /api/projects?visible=true` request
**When** projects with `visible=false` exist
**Then** the response MUST exclude those projects

**Given** the same endpoint without the `visible` query parameter
**Then** the response MUST include all projects regardless of `visible`

---

## 3. Get Project by ID

### REQ-GET-1: Returns 200 with project when ID exists

**Given** an authenticated `GET /api/projects/:id` request
**When** the project exists
**Then** the server MUST respond with HTTP 200
**And** the body MUST be a single `Project` object including `taskCounts` and any populated FK references

### REQ-GET-2: Returns 404 when ID does not exist

**Given** an authenticated `GET /api/projects/:id` request
**When** no project with the given `id` exists
**Then** the server MUST respond with HTTP 404
**And** the body MUST contain `{ "code": "PROJECT_NOT_FOUND" }`

---

## 4. Create Project

### REQ-CREATE-1: Valid body creates project and returns 201

**Given** an authenticated `POST /api/projects` request
**And** the body satisfies `CreateProjectSchema` with at minimum `title` non-empty
**When** the request is processed
**Then** the server MUST respond with HTTP 201
**And** the body MUST be the newly created `Project` with a generated `id`
**And** `taskCounts` MUST be `{ nuevo: 0, enProgreso: 0, hecho: 0, total: 0 }`
**And** `visible` MUST default to `true` when omitted

### REQ-CREATE-2: Title required

**Given** an authenticated `POST /api/projects` request
**And** the body omits `title` OR `title` is an empty/whitespace string
**Then** the server MUST respond with HTTP 400
**And** the body MUST contain `{ "code": "VALIDATION_ERROR" }`

### REQ-CREATE-3: Invalid field type returns 400

**Given** an authenticated `POST /api/projects` request
**And** any optional field has a wrong type (e.g. `visible: "yes"` or `partnerIds: "p1"` not an array)
**Then** the server MUST respond with HTTP 400
**And** the body MUST contain `{ "code": "VALIDATION_ERROR" }`

### REQ-CREATE-4: Unknown categoryId returns 404

**Given** an authenticated `POST /api/projects` request
**And** the body contains a `categoryId` that does not exist in `ProjectCategory`
**Then** the server MUST respond with HTTP 404
**And** the body MUST contain `{ "code": "CATEGORY_NOT_FOUND" }`

### REQ-CREATE-5: Unknown typeId returns 404

**Given** an authenticated `POST /api/projects` request
**And** the body contains a `typeId` that does not exist in `ProjectType`
**Then** the server MUST respond with HTTP 404
**And** the body MUST contain `{ "code": "TYPE_NOT_FOUND" }`

### REQ-CREATE-6: Unknown workflowId returns 404

**Given** an authenticated `POST /api/projects` request
**And** the body contains a `workflowId` that does not exist in `Workflow`
**Then** the server MUST respond with HTTP 404
**And** the body MUST contain `{ "code": "WORKFLOW_NOT_FOUND" }`

### REQ-CREATE-7: Unknown projectLeadId returns 404

**Given** an authenticated `POST /api/projects` request
**And** the body contains a `projectLeadId` that does not exist in `Admin`
**Then** the server MUST respond with HTTP 404
**And** the body MUST contain `{ "code": "LEAD_NOT_FOUND" }`

### REQ-CREATE-8: Unknown partnerId in partnerIds returns 404

**Given** an authenticated `POST /api/projects` request
**And** the body contains a `partnerIds` array with at least one ID that does not exist in `Partner`
**Then** the server MUST respond with HTTP 404
**And** the body MUST contain `{ "code": "PARTNER_NOT_FOUND" }`
**And** NO project MUST be created (transaction rolled back)

### REQ-CREATE-9: All optional fields nullable

**Given** an authenticated `POST /api/projects` request with `description: null`, `typeId: null`, `categoryId: null`, `workflowId: null`, `projectLeadId: null`
**When** the request is processed
**Then** the server MUST respond with HTTP 201
**And** the response MUST carry those fields as `null`

### REQ-CREATE-10: partnerIds defaults to empty

**Given** an authenticated `POST /api/projects` request that omits `partnerIds`
**When** the request is processed
**Then** the created project MUST have an empty partner set
**And** the response `partners` field (if surfaced) MUST be `[]`

---

## 5. Update Project

### REQ-UPDATE-1: Valid partial body updates project and returns 200

**Given** an authenticated `PUT /api/projects/:id` request
**And** the project exists
**And** the body satisfies `UpdateProjectSchema` (all fields optional)
**When** the request is processed
**Then** the server MUST respond with HTTP 200
**And** the body MUST be the updated `Project`

### REQ-UPDATE-2: Returns 404 when ID does not exist

**Given** an authenticated `PUT /api/projects/:id` request
**And** no project with the given `id` exists
**Then** the server MUST respond with HTTP 404
**And** the body MUST contain `{ "code": "PROJECT_NOT_FOUND" }`

### REQ-UPDATE-3: Invalid field type returns 400

**Given** an authenticated `PUT /api/projects/:id` request
**And** any field has a wrong type
**Then** the server MUST respond with HTTP 400
**And** the body MUST contain `{ "code": "VALIDATION_ERROR" }`

### REQ-UPDATE-4: Unknown FK returns 404 with the right code

**Given** an authenticated `PUT /api/projects/:id` request
**And** the body sets `categoryId | typeId | workflowId | projectLeadId` to a non-existent value
**Then** the server MUST respond with HTTP 404
**And** the body `code` MUST be the matching one of `CATEGORY_NOT_FOUND | TYPE_NOT_FOUND | WORKFLOW_NOT_FOUND | LEAD_NOT_FOUND`

### REQ-UPDATE-5: Setting an FK to null is permitted

**Given** an authenticated `PUT /api/projects/:id` request
**And** the body explicitly sets `categoryId: null` (or any of the optional FKs)
**When** the request is processed
**Then** the server MUST respond with HTTP 200
**And** the corresponding FK in the stored row MUST be NULL

---

## 6. Partner Replace-Set Semantics

### REQ-PARTNERS-1: partnerIds in PUT replaces the entire set

**Given** an authenticated `PUT /api/projects/:id` request
**And** the project currently has partners `["p1", "p2"]`
**And** the body contains `partnerIds: ["p1", "p3"]`
**When** the request is processed
**Then** the server MUST respond with HTTP 200
**And** the project's partner set MUST equal `{p1, p3}` (p2 removed, p3 added)

### REQ-PARTNERS-2: Empty partnerIds removes all partners

**Given** an authenticated `PUT /api/projects/:id` request
**And** the project currently has partners `["p1", "p2"]`
**And** the body contains `partnerIds: []`
**When** the request is processed
**Then** the server MUST respond with HTTP 200
**And** the project's partner set MUST be empty

### REQ-PARTNERS-3: Omitting partnerIds preserves the existing set

**Given** an authenticated `PUT /api/projects/:id` request
**And** the project currently has partners `["p1", "p2"]`
**And** the body omits `partnerIds` entirely
**When** the request is processed
**Then** the server MUST respond with HTTP 200
**And** the project's partner set MUST still be `{p1, p2}`

### REQ-PARTNERS-4: Unknown partnerId in PUT returns 404 atomically

**Given** an authenticated `PUT /api/projects/:id` request
**And** the body contains `partnerIds` including at least one non-existent partner
**When** the request is processed
**Then** the server MUST respond with HTTP 404 with `{ "code": "PARTNER_NOT_FOUND" }`
**And** the project's existing partner set MUST remain unchanged (transaction rolled back)
**And** the project's other fields in the same payload MUST NOT be applied

### REQ-PARTNERS-5: Duplicate IDs in partnerIds deduplicated

**Given** an authenticated `PUT /api/projects/:id` request
**And** the body contains `partnerIds: ["p1", "p1", "p2"]`
**When** the request is processed
**Then** the resulting partner set MUST equal `{p1, p2}` (no error, duplicates collapsed)

---

## 7. Delete Project

### REQ-DELETE-1: Deleting an existing project returns 204

**Given** an authenticated `DELETE /api/projects/:id` request
**And** the project exists
**When** the request is processed
**Then** the server MUST respond with HTTP 204
**And** the response body MUST be empty
**And** all `ProjectPartner` rows for this project MUST be deleted (cascade)

### REQ-DELETE-2: Deleting a non-existent project returns 404

**Given** an authenticated `DELETE /api/projects/:id` request
**And** no project with the given `id` exists
**Then** the server MUST respond with HTTP 404
**And** the body MUST contain `{ "code": "PROJECT_NOT_FOUND" }`

### REQ-DELETE-3: Deleting a project with linked tasks does NOT cascade tasks

**Given** an authenticated `DELETE /api/projects/:id` request
**And** the project has linked `ScheduledTask` rows
**When** the request is processed
**Then** either:
- the server MUST respond with HTTP 204 AND the linked tasks MUST have `projectId = NULL` (Prisma `SetNull` on relation), OR
- the server MUST respond with HTTP 409 (`{ "code": "PROJECT_HAS_TASKS" }`) if the schema is configured to `Restrict`.

The concrete choice is documented in `design.md §AD-8`. The default selected for this change is **SetNull** (no behavioral change vs. current schema).

---

## 8. Response Shape

### REQ-SHAPE-1: Project response object structure

Every `Project` response object MUST contain at minimum the following fields:

| Field | Type | Nullable |
|-------|------|----------|
| `id` | `string` | No |
| `title` | `string` | No |
| `description` | `string \| null` | Yes |
| `typeId` | `string \| null` | Yes |
| `categoryId` | `string \| null` | Yes |
| `workflowId` | `string \| null` | Yes |
| `projectLeadId` | `string \| null` | Yes |
| `visible` | `boolean` | No |
| `partners` | `Array<{ id: string, name: string }>` | No (MAY be empty) |
| `taskCounts` | `{ nuevo: number, enProgreso: number, hecho: number, total: number }` | No |
| `createdAt` | `string` (ISO 8601) | No |
| `updatedAt` | `string` (ISO 8601) | No |

### REQ-SHAPE-2: Prisma adapter MUST NOT return undefined for nullable fields

The mapper in `PrismaProjectRepository` MUST use `?? null` for all nullable fields. `undefined` is not a valid response value.

### REQ-SHAPE-3: partners always present as an array

Even when a project has zero partners, the response MUST include `partners: []` (never `null`, never absent).

---

## 9. Validation Schemas

### REQ-VAL-1: `CreateProjectSchema` shape

- `title`: `z.string().min(1).trim()` — required
- `description`: `z.string().nullable().optional()`
- `typeId`: `z.string().uuid().nullable().optional()`
- `categoryId`: `z.string().uuid().nullable().optional()`
- `workflowId`: `z.string().uuid().nullable().optional()`
- `projectLeadId`: `z.string().uuid().nullable().optional()`
- `visible`: `z.boolean().optional()` (defaults to `true`)
- `partnerIds`: `z.array(z.string().uuid()).optional()` (defaults to `[]`)

### REQ-VAL-2: `UpdateProjectSchema` is a partial of `CreateProjectSchema`

All fields MUST be optional. The same per-field validators apply.

### REQ-VAL-3: `ListProjectsQuerySchema`

- `visible`: `z.enum(['true', 'false']).optional()` — query strings are stringly-typed; conversion to boolean happens after parse.

---

## 10. Dependency Inversion Preservation

### REQ-DIP-1: No `@infrastructure/*` imports in application layer

`src/application/dto/projects.dto.ts` and the five new use-case files MUST NOT import from `@infrastructure/*`.

### REQ-DIP-2: Use cases depend on domain ports only

The five use cases MAY depend on `ProjectRepository`, `ProjectCategoryRepository`, `ProjectTypeRepository`, `WorkflowRepository`, `PartnerRepository`, and `AdminRepository` (all in `src/domain/ports/`). They MUST NOT import Prisma types directly.

### REQ-DIP-3: `createProjectsRouter` receives use cases + authProvider, not the repo

The factory signature MUST change from `(repo: ProjectRepository)` to `(listProjects, getProject, createProject, updateProject, deleteProject, authProvider)`. It MUST NOT construct or import a concrete `JwtAuthAdapter` internally.

---

## 11. IClass SO Type Mapping

> Preserved from change `iclass-so-type-mapping`. A `Project` MAY be linked to exactly one IClass SO type at a time (or none). The mapping is nullable; operators assign it manually.

### REQ-PROJ-ICLASS-1: `Project` entity gains `iclassSoTypeId` and `iclassSoType`

The `Project` entity is extended with `iclassSoTypeId: string | null` and `iclassSoType: { id: string; code: string; description: string; active: boolean } | null`. Use cases that return `Project` MUST propagate both fields.

### REQ-PROJ-ICLASS-2: `UpdateProjectInput` accepts `iclassSoTypeId`

`UpdateProjectInput` MUST include `iclassSoTypeId?: string | null`. Passing `null` explicitly clears the mapping; omitting it leaves the existing mapping unchanged.

### REQ-PROJ-ICLASS-3: Assigning an inactive `iclassSoTypeId` is rejected

**Given** a `PATCH`/`PUT /api/projects/:id` request with an `iclassSoTypeId` resolving to an entry with `active: false`
**Then** the handler MUST respond HTTP 422 with `{ code: "ICLASS_SO_TYPE_INACTIVE", iclassSoTypeId: "<id>" }`
**And** the project MUST NOT be modified.

### REQ-PROJ-ICLASS-4: Assigning a non-existent `iclassSoTypeId` is rejected

**Given** an `iclassSoTypeId` that does not resolve
**Then** the handler MUST respond HTTP 404 with `{ code: "ICLASS_SO_TYPE_NOT_FOUND" }`
**And** the project MUST NOT be modified.

### REQ-PROJ-ICLASS-5: Setting `iclassSoTypeId: null` clears the mapping

**Given** a project with an active mapping and a body `{ "iclassSoTypeId": null }`
**Then** HTTP 200 and the returned project MUST have `iclassSoTypeId: null` and `iclassSoType: null`.

### REQ-PROJ-ICLASS-6: Active type is accepted and persisted

**Given** a body `{ "iclassSoTypeId": "<active-id>" }`
**Then** HTTP 200 and the returned project MUST have the assigned `iclassSoTypeId` and the full inline `iclassSoType`.

### REQ-PROJ-ICLASS-7: Write surface and validation

`PATCH /api/projects/:id` is the write surface; `PUT /api/projects/:id` MUST also accept the field (same schema). Non-string, non-null values MUST be rejected with 400 `VALIDATION_ERROR`.

### REQ-PROJ-ICLASS-8: All project responses include `iclassSoTypeId` and `iclassSoType`

Every endpoint returning a `Project` (GET list, GET by id, POST, PUT, PATCH) MUST include `iclassSoTypeId: string | null` and `iclassSoType: { id, code, description, active } | null`. `iclassSoType` MUST be `null` when `iclassSoTypeId` is `null`, and the full inline object when set.

| Error | HTTP | `code` |
|-------|------|--------|
| `IClassSoTypeInactiveError` | 422 | `ICLASS_SO_TYPE_INACTIVE` (+ `iclassSoTypeId`) |
| `IClassSoTypeNotFoundError` | 404 | `ICLASS_SO_TYPE_NOT_FOUND` |

---

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
| Project ID not found | 404 | `PROJECT_NOT_FOUND` |
| ProjectCategory ID not found | 404 | `CATEGORY_NOT_FOUND` |
| ProjectType ID not found | 404 | `TYPE_NOT_FOUND` |
| Workflow ID not found | 404 | `WORKFLOW_NOT_FOUND` |
| Admin (project lead) ID not found | 404 | `LEAD_NOT_FOUND` |
| Partner ID not found | 404 | `PARTNER_NOT_FOUND` |
