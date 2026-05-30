# Spec: Scheduling Workflows Capability

**Capability**: `scheduling-workflows`
**Type**: New
**Change**: `scheduling-foundation-stage-model`
**Routes**:
- `GET /api/scheduling/workflows`
- `GET /api/scheduling/workflows/:id`
- `POST /api/scheduling/workflows`
- `PUT /api/scheduling/workflows/:id`
- `DELETE /api/scheduling/workflows/:id`
- `POST /api/scheduling/workflows/:id/stages`
- `PUT /api/scheduling/workflows/:id/stages/reorder`
- `DELETE /api/scheduling/workflows/:id/stages/:stageId`
- `GET /api/scheduling/project-categories`, `POST/PUT/DELETE /api/scheduling/project-categories[/:id]`
- `GET /api/scheduling/project-types`, `POST/PUT/DELETE /api/scheduling/project-types[/:id]`

This capability covers admin-side configuration of Workflows (and their Stages) plus the two supporting taxonomies, ProjectCategory and ProjectType. **Choice**: ProjectCategory and ProjectType ride in this capability rather than a separate spec — they are tiny CRUD surfaces that exist to feed the Project enrichment in the *next* change. Splitting them would create three near-empty specs.

---

## 1. Authentication

All routes in this capability MUST enforce authentication via the `auth_token` cookie using `createAuthMiddleware(JwtAuthAdapter)`. The pattern mirrors `clients.routes.ts:94` — per-route `auth` middleware injected by `createWorkflowsRouter(authProvider, …)`.

### REQ-WF-AUTH-1: Missing cookie is rejected on every workflows route

**Given** a request to any `/api/scheduling/workflows[/...]` route without an `auth_token` cookie
**When** the request is received
**Then** the server MUST respond with HTTP 401
**And** the body MUST contain `{ "code": "UNAUTHORIZED" }`

### REQ-WF-AUTH-2: Missing cookie is rejected on project-categories and project-types routes

**Given** a request to any `/api/scheduling/project-categories[/...]` or `/api/scheduling/project-types[/...]` route without an `auth_token` cookie
**When** the request is received
**Then** the server MUST respond with HTTP 401
**And** the body MUST contain `{ "code": "UNAUTHORIZED" }`

### REQ-WF-AUTH-3: Invalid token is rejected

**Given** any request to a workflows-capability route with a cookie that cannot be verified
**When** the request is received
**Then** the server MUST respond with HTTP 401

---

## 2. List Workflows

### REQ-WF-LIST-1: Returns all workflows as a JSON array

**Given** an authenticated `GET /api/scheduling/workflows`
**When** the request is processed
**Then** the server MUST respond with HTTP 200
**And** the body MUST be a JSON array
**And** each element MUST be a `Workflow` object including a `stages` array sorted by `order` ascending

### REQ-WF-LIST-2: Returns the Default workflow first after seeding

**Given** a freshly seeded database
**When** `GET /api/scheduling/workflows` is called
**Then** the body MUST contain at least one element with `name: "Default"` carrying 11 stages
**And** the 11 stages MUST be in the documented seed order (see REQ-WF-SEED-1)

---

## 3. Get Workflow by ID

### REQ-WF-GET-1: Returns 200 with workflow when ID exists

**Given** an authenticated `GET /api/scheduling/workflows/:id`
**When** the workflow with the given `id` exists
**Then** the server MUST respond with HTTP 200
**And** the body MUST be a `Workflow` object including its `stages` array sorted by `order` ascending

### REQ-WF-GET-2: Returns 404 when ID does not exist

**Given** an authenticated `GET /api/scheduling/workflows/:id`
**When** no workflow with the given `id` exists
**Then** the server MUST respond with HTTP 404
**And** the body MUST contain `{ "code": "WORKFLOW_NOT_FOUND" }`

---

## 4. Create Workflow

### REQ-WF-CREATE-1: Valid body creates workflow and returns 201

**Given** an authenticated `POST /api/scheduling/workflows`
**And** the body is `{ "name": "<non-empty string>", "description": <string|null>, "stages": [<stage spec>...] }` where each stage spec is `{ "name": string, "category": 'nuevo'|'enProgreso'|'hecho', "order": number }`
**When** the request is processed
**Then** the server MUST respond with HTTP 201
**And** the body MUST be the newly created `Workflow` with generated `id` for the workflow and each stage
**And** the body `stages` MUST be sorted by `order` ascending

### REQ-WF-CREATE-2: Empty name returns 400

**Given** an authenticated `POST /api/scheduling/workflows`
**And** the body contains `name: ""`
**When** the request is processed
**Then** the server MUST respond with HTTP 400
**And** the body MUST contain `{ "code": "VALIDATION_ERROR" }`

### REQ-WF-CREATE-3: Invalid stage category returns 400

**Given** an authenticated `POST /api/scheduling/workflows`
**And** the body contains a stage with `category: "DONE"` (not in the enum)
**When** the request is processed
**Then** the server MUST respond with HTTP 400
**And** the body MUST contain `{ "code": "VALIDATION_ERROR" }`

### REQ-WF-CREATE-4: Duplicate workflow name returns 409

**Given** an authenticated `POST /api/scheduling/workflows`
**And** a workflow with the same `name` already exists (case-insensitive)
**When** the request is processed
**Then** the server MUST respond with HTTP 409
**And** the body MUST contain `{ "code": "WORKFLOW_NAME_CONFLICT" }`

### REQ-WF-CREATE-5: Stages array MAY be empty on create

**Given** an authenticated `POST /api/scheduling/workflows`
**And** the body contains `stages: []`
**When** the request is processed
**Then** the server MUST respond with HTTP 201
**And** the resulting workflow MUST have `stages: []`

---

## 5. Update Workflow

### REQ-WF-UPDATE-1: Valid partial body updates workflow and returns 200

**Given** an authenticated `PUT /api/scheduling/workflows/:id`
**And** the workflow exists
**And** the body is a partial `{ name?, description? }`
**When** the request is processed
**Then** the server MUST respond with HTTP 200
**And** the body MUST be the updated `Workflow` including its current `stages`
**Note**: `PUT` to this route MUST NOT replace the `stages` array. Stage mutations go through `/stages`, `/stages/reorder`, and `/stages/:stageId` (REQ-STAGE-*).

### REQ-WF-UPDATE-2: Returns 404 when workflow ID does not exist

**Given** an authenticated `PUT /api/scheduling/workflows/:id`
**And** no workflow with the given `id` exists
**When** the request is processed
**Then** the server MUST respond with HTTP 404
**And** the body MUST contain `{ "code": "WORKFLOW_NOT_FOUND" }`

### REQ-WF-UPDATE-3: Renaming to an existing name returns 409

**Given** an authenticated `PUT /api/scheduling/workflows/:id`
**And** the new `name` collides with another workflow's name (case-insensitive)
**When** the request is processed
**Then** the server MUST respond with HTTP 409
**And** the body MUST contain `{ "code": "WORKFLOW_NAME_CONFLICT" }`

---

## 6. Delete Workflow

### REQ-WF-DELETE-1: Deleting an existing workflow returns 204

**Given** an authenticated `DELETE /api/scheduling/workflows/:id`
**And** the workflow exists
**And** no Stage in that workflow is referenced by any `ScheduledTask`
**When** the request is processed
**Then** the server MUST respond with HTTP 204
**And** the response body MUST be empty
**And** all Stages belonging to the workflow MUST be cascade-deleted

### REQ-WF-DELETE-2: Returns 404 when ID does not exist

**Given** an authenticated `DELETE /api/scheduling/workflows/:id`
**And** no workflow with the given `id` exists
**When** the request is processed
**Then** the server MUST respond with HTTP 404
**And** the body MUST contain `{ "code": "WORKFLOW_NOT_FOUND" }`

### REQ-WF-DELETE-3: Deleting a workflow whose Stages are in use returns 409

**Given** an authenticated `DELETE /api/scheduling/workflows/:id`
**And** at least one Stage belonging to the workflow is referenced by a `ScheduledTask.stageId`
**When** the request is processed
**Then** the server MUST respond with HTTP 409
**And** the body MUST contain `{ "code": "WORKFLOW_IN_USE", "details": { "taskCount": <number> } }`

### REQ-WF-DELETE-4: Default workflow MUST NOT be deletable

**Given** an authenticated `DELETE /api/scheduling/workflows/:id` targeting the workflow with `name: "Default"`
**When** the request is processed
**Then** the server MUST respond with HTTP 409
**And** the body MUST contain `{ "code": "DEFAULT_WORKFLOW_PROTECTED" }`

---

## 7. Add Stage to Workflow

### REQ-STAGE-ADD-1: Valid body adds a stage and returns 201

**Given** an authenticated `POST /api/scheduling/workflows/:id/stages`
**And** the workflow exists
**And** the body is `{ "name": <non-empty string>, "category": 'nuevo'|'enProgreso'|'hecho', "order": <number> }`
**When** the request is processed
**Then** the server MUST respond with HTTP 201
**And** the body MUST be the newly created `Stage` with generated `id`
**And** the new Stage MUST belong to the workflow

### REQ-STAGE-ADD-2: Missing or invalid fields return 400

**Given** an authenticated `POST /api/scheduling/workflows/:id/stages`
**And** the body is missing `name`, `category`, or `order`, OR a field has the wrong type
**When** the request is processed
**Then** the server MUST respond with HTTP 400
**And** the body MUST contain `{ "code": "VALIDATION_ERROR" }`

### REQ-STAGE-ADD-3: Workflow not found returns 404

**Given** an authenticated `POST /api/scheduling/workflows/:id/stages`
**And** no workflow with the given `id` exists
**When** the request is processed
**Then** the server MUST respond with HTTP 404
**And** the body MUST contain `{ "code": "WORKFLOW_NOT_FOUND" }`

### REQ-STAGE-ADD-4: Duplicate stage name within a workflow returns 409

**Given** an authenticated `POST /api/scheduling/workflows/:id/stages`
**And** a Stage with the same `name` already exists in that workflow (case-insensitive)
**When** the request is processed
**Then** the server MUST respond with HTTP 409
**And** the body MUST contain `{ "code": "STAGE_NAME_CONFLICT" }`

---

## 8. Reorder Stages

### REQ-STAGE-REORDER-1: Valid ordered list updates `order` and returns 200

**Given** an authenticated `PUT /api/scheduling/workflows/:id/stages/reorder`
**And** the workflow exists
**And** the body is `{ "order": [<stageId1>, <stageId2>, ...] }` containing exactly the set of Stage IDs belonging to the workflow
**When** the request is processed
**Then** the server MUST respond with HTTP 200
**And** every Stage in the workflow MUST have `order` equal to its index in the array (0-based)
**And** the response body MUST be the workflow with its `stages` array sorted by the new `order`

### REQ-STAGE-REORDER-2: Mismatched id set returns 400

**Given** an authenticated `PUT /api/scheduling/workflows/:id/stages/reorder`
**And** the `order` array contains an ID not belonging to the workflow OR omits a Stage ID belonging to the workflow OR contains duplicates
**When** the request is processed
**Then** the server MUST respond with HTTP 400
**And** the body MUST contain `{ "code": "REORDER_SET_MISMATCH" }`

### REQ-STAGE-REORDER-3: Workflow not found returns 404

**Given** an authenticated `PUT /api/scheduling/workflows/:id/stages/reorder`
**And** no workflow with the given `id` exists
**When** the request is processed
**Then** the server MUST respond with HTTP 404
**And** the body MUST contain `{ "code": "WORKFLOW_NOT_FOUND" }`

---

## 9. Remove Stage from Workflow

### REQ-STAGE-DELETE-1: Deleting an unused stage returns 204

**Given** an authenticated `DELETE /api/scheduling/workflows/:id/stages/:stageId`
**And** the Stage exists and belongs to the workflow
**And** no `ScheduledTask` references the Stage
**When** the request is processed
**Then** the server MUST respond with HTTP 204
**And** the response body MUST be empty

### REQ-STAGE-DELETE-2: Stage in use returns 409

**Given** an authenticated `DELETE /api/scheduling/workflows/:id/stages/:stageId`
**And** at least one `ScheduledTask` has `stageId` equal to the Stage
**When** the request is processed
**Then** the server MUST respond with HTTP 409
**And** the body MUST contain `{ "code": "STAGE_IN_USE", "details": { "taskCount": <number> } }`

### REQ-STAGE-DELETE-3: Stage not found returns 404

**Given** an authenticated `DELETE /api/scheduling/workflows/:id/stages/:stageId`
**And** the Stage does not exist OR does not belong to the workflow
**When** the request is processed
**Then** the server MUST respond with HTTP 404
**And** the body MUST contain `{ "code": "STAGE_NOT_FOUND" }`

---

## 10. Seeded State

### REQ-WF-SEED-1: Default workflow seeded with 11 stages

After `npm run prisma:seed`, the database MUST contain a Workflow named `"Default"` with the following 11 Stages in this order and category mapping (derived from `md/splynx-scheduling/snapshots/scheduling-tasks-filtered-snapshot.yml`):

| order | name | category |
|-------|------|----------|
| 0 | Nuevo | nuevo |
| 1 | Confirmado | nuevo |
| 2 | Pospuesta | nuevo |
| 3 | No Factible | nuevo |
| 4 | Enviar a IClass | nuevo |
| 5 | Registrado en IClass | nuevo |
| 6 | Notificado | nuevo |
| 7 | En progreso | enProgreso |
| 8 | Instalado | hecho |
| 9 | Hecho | hecho |
| 10 | Anulado-Cancelado | hecho |

### REQ-WF-SEED-2: Seed is idempotent

Re-running `npm run prisma:seed` MUST NOT create duplicate Workflows or Stages. The seed MUST use `upsert` keyed by `name` (workflow) and `(workflowId, name)` (stage).

---

## 11. ProjectCategory CRUD

### REQ-PC-LIST-1: GET /api/scheduling/project-categories returns array

**Given** an authenticated `GET /api/scheduling/project-categories`
**When** the request is processed
**Then** the server MUST respond with HTTP 200
**And** the body MUST be a JSON array of `ProjectCategory` objects (`{ id, name, description }`)

### REQ-PC-CREATE-1: Valid body creates and returns 201

**Given** an authenticated `POST /api/scheduling/project-categories`
**And** the body is `{ "name": <non-empty string>, "description": <string|null> }`
**When** the request is processed
**Then** the server MUST respond with HTTP 201

### REQ-PC-CREATE-2: Duplicate name returns 409

**Given** an authenticated `POST /api/scheduling/project-categories`
**And** a category with the same `name` already exists (case-insensitive)
**Then** the server MUST respond with HTTP 409
**And** the body MUST contain `{ "code": "PROJECT_CATEGORY_NAME_CONFLICT" }`

### REQ-PC-UPDATE-1: PUT returns 200 / 404 / 409

`PUT /api/scheduling/project-categories/:id` MUST mirror REQ-WF-UPDATE-1, REQ-WF-UPDATE-2, REQ-WF-UPDATE-3 with code `PROJECT_CATEGORY_NOT_FOUND` / `PROJECT_CATEGORY_NAME_CONFLICT`.

### REQ-PC-DELETE-1: DELETE returns 204 / 404 / 409

`DELETE /api/scheduling/project-categories/:id`:
- 204 when the category exists and no Project references it
- 404 when the category does not exist (`PROJECT_CATEGORY_NOT_FOUND`)
- 409 when the category is referenced by at least one Project (`PROJECT_CATEGORY_IN_USE`). **Note**: until change `scheduling-projects-enrich` adds `Project.categoryId`, this 409 branch is dormant — implement the check defensively (count references; result is 0).

### REQ-PC-VALIDATION-1: Empty or non-string name returns 400

Any create/update with `name` empty, missing, or non-string MUST return HTTP 400 with `code: 'VALIDATION_ERROR'`.

---

## 12. ProjectType CRUD

Mirror of §11 for ProjectType. Codes:
- `PROJECT_TYPE_NOT_FOUND` (404)
- `PROJECT_TYPE_NAME_CONFLICT` (409 on create / rename)
- `PROJECT_TYPE_IN_USE` (409 on delete; dormant until `scheduling-projects-enrich`)

`ProjectType` shape: `{ id, name, description }`.

REQ-PT-LIST-1, REQ-PT-CREATE-1, REQ-PT-CREATE-2, REQ-PT-UPDATE-1, REQ-PT-DELETE-1, REQ-PT-VALIDATION-1 are defined identically to the ProjectCategory section above with substituted code names.

---

## 13. Response Shape Consistency

### REQ-WF-SHAPE-1: Workflow response shape

Every `Workflow` response object MUST contain:

| Field | Type | Nullable |
|-------|------|----------|
| `id` | `string` | No |
| `name` | `string` | No |
| `description` | `string \| null` | Yes |
| `stages` | `Stage[]` (sorted by `order` ascending) | No |
| `createdAt` | `string` (ISO 8601) | No |
| `updatedAt` | `string` (ISO 8601) | No |

### REQ-WF-SHAPE-2: Stage response shape

Every `Stage` response object MUST contain:

| Field | Type | Nullable |
|-------|------|----------|
| `id` | `string` | No |
| `workflowId` | `string` | No |
| `name` | `string` | No |
| `category` | `'nuevo' \| 'enProgreso' \| 'hecho'` | No |
| `order` | `number` (non-negative integer) | No |

---

## 14. Validation Schemas

### REQ-WF-VAL-1: `CreateWorkflowSchema`

The schema MUST require: `name: z.string().min(1)`.
The schema MUST allow optional/nullable: `description: z.string().nullable().optional()`, `stages: z.array(CreateStageSchema).optional()`.

### REQ-WF-VAL-2: `CreateStageSchema`

The schema MUST require: `name: z.string().min(1)`, `category: z.enum(['nuevo','enProgreso','hecho'])`, `order: z.number().int().nonnegative()`.

### REQ-WF-VAL-3: `UpdateWorkflowSchema`

`z.object({ name: z.string().min(1).optional(), description: z.string().nullable().optional() })`. The schema MUST NOT include `stages` (use the stage sub-routes).

### REQ-WF-VAL-4: `ReorderStagesSchema`

`z.object({ order: z.array(z.string().uuid()).min(1) })`. The use case (not the schema) enforces set-equality with the workflow's Stages (REQ-STAGE-REORDER-2).

---

## 15. Dependency Inversion Preservation

### REQ-WF-DIP-1: No `@infrastructure/*` imports in application layer

`src/application/use-cases/*Workflow*.ts`, `*Stage*.ts`, `*ProjectCategory*.ts`, `*ProjectType*.ts` MUST NOT import from `@infrastructure/*`. Verified by `tsc --noEmit`.

### REQ-WF-DIP-2: `createWorkflowsRouter` receives `authProvider` as a parameter

The router factory MUST accept `authProvider: AuthProvider` and all required use cases as parameters. It MUST NOT construct concrete adapters internally.

---

## Appendix: Error Response Format

All error responses MUST follow the shape inherited from the base `scheduling` spec:

```json
{
  "error": "<human-readable message>",
  "code": "<machine-readable code>",
  "details": "<optional, zod issues or { taskCount } payload>"
}
```

| Scenario | HTTP | `code` |
|----------|------|--------|
| Missing / invalid auth | 401 | `UNAUTHORIZED` |
| Zod validation failure | 400 | `VALIDATION_ERROR` |
| Workflow not found | 404 | `WORKFLOW_NOT_FOUND` |
| Stage not found | 404 | `STAGE_NOT_FOUND` |
| ProjectCategory not found | 404 | `PROJECT_CATEGORY_NOT_FOUND` |
| ProjectType not found | 404 | `PROJECT_TYPE_NOT_FOUND` |
| Workflow name collision | 409 | `WORKFLOW_NAME_CONFLICT` |
| Default workflow delete | 409 | `DEFAULT_WORKFLOW_PROTECTED` |
| Workflow has tasks via its stages | 409 | `WORKFLOW_IN_USE` |
| Stage in use by tasks | 409 | `STAGE_IN_USE` |
| Stage name collision in workflow | 409 | `STAGE_NAME_CONFLICT` |
| Reorder set mismatch | 400 | `REORDER_SET_MISMATCH` |
| ProjectCategory / ProjectType name collision | 409 | `PROJECT_CATEGORY_NAME_CONFLICT` / `PROJECT_TYPE_NAME_CONFLICT` |
| ProjectCategory / ProjectType in use | 409 | `PROJECT_CATEGORY_IN_USE` / `PROJECT_TYPE_IN_USE` |
