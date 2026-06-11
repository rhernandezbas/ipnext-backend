# Delta for Scheduling

**Capability**: `scheduling`
**Type**: Delta (modifies existing spec at `openspec/specs/scheduling/spec.md`)
**Change**: `tareas-nodos-page` (#40)

---

## ADDED Requirements

### Requirement: REQ-KIND-FILTER-1 — `kind` query parameter filters task list

`GET /api/scheduling` MUST accept an optional `kind` query parameter with values `'customer'` or `'network'`. When omitted, the endpoint MUST return all tasks regardless of kind (current behavior preserved). When provided, only tasks matching the given `kind` MUST be returned. This is additive; no existing caller is affected.

#### Scenario: kind=network returns only network tasks

- GIVEN authenticated `GET /api/scheduling?kind=network`
- AND the repository contains both customer and network tasks
- WHEN the request is processed
- THEN the server MUST respond with HTTP 200
- AND every task in the response MUST have `kind: 'network'`
- AND customer tasks MUST be absent

#### Scenario: kind=customer returns only customer tasks

- GIVEN authenticated `GET /api/scheduling?kind=customer`
- WHEN the request is processed
- THEN every task in the response MUST have `kind: 'customer'`

#### Scenario: kind omitted returns all tasks (backward compat)

- GIVEN authenticated `GET /api/scheduling` with no `kind` param
- WHEN the request is processed
- THEN tasks with BOTH `kind='customer'` AND `kind='network'` MUST be returned

#### Scenario: Invalid kind value returns 400

- GIVEN `GET /api/scheduling?kind=mixed`
- THEN the server MUST respond with HTTP 400
- AND the body MUST contain `{ "code": "VALIDATION_ERROR" }`

#### Scenario: kind=network + priority filter combo

- GIVEN `GET /api/scheduling?kind=network&priority=high`
- THEN the response MUST contain only network tasks with `priority='high'`

---

### Requirement: REQ-KIND-FILTER-2 — `kind` added to `ListTasksFilterSchema` and `TaskListFilter`

The Zod schema `ListTasksFilterSchema` MUST add `kind: z.enum(['customer', 'network']).optional()`. The domain DTO `TaskListFilter` MUST add `kind?: 'customer' | 'network'`. The FE type `TaskListFilter` in `src/types/scheduling.ts` MUST also add `kind?: 'customer' | 'network'`. The `buildFilterParams` function in `scheduling.api.ts` MUST serialize `kind` when present.

#### Scenario: Schema passes kind to repository

- GIVEN `ListTasksFilterSchema.parse({ kind: 'network' })` succeeds
- WHEN `ListTasks.execute` receives it
- THEN `repo.listTasks({ kind: 'network' })` MUST be called

---

### Requirement: REQ-PROJECT-KIND-GUARD-1 — CreateTask enforces project-kind match

When `kind='network'` is provided and `projectId` is non-null, `CreateTask` MUST verify that `project.isNetworkProject === true`. If the project is NOT a network project, the request MUST be rejected with HTTP 422 `INVALID_PROJECT_KIND`. Symmetrically, when `kind='customer'` and `projectId` is non-null, `CreateTask` MUST verify that `project.isNetworkProject === false`; if the project IS a network project, the request MUST be rejected with HTTP 422 `INVALID_PROJECT_KIND`. Tasks with `projectId: null` MUST bypass both checks (existing behavior — REQ-CREATE-13 preserved).

#### Scenario: Network task with non-network project is rejected

- GIVEN `POST /api/scheduling` with `{ kind: 'network', networkSiteId: '<id>', projectId: '<customer-project-id>' }`
- AND the project has `isNetworkProject: false`
- WHEN the request is processed
- THEN the server MUST respond with HTTP 422
- AND the body MUST contain `{ "code": "INVALID_PROJECT_KIND" }`
- AND NO task MUST be persisted

#### Scenario: Network task with network project succeeds

- GIVEN `POST /api/scheduling` with `{ kind: 'network', networkSiteId: '<id>', projectId: '<network-project-id>' }`
- AND the project has `isNetworkProject: true`
- WHEN the request is processed
- THEN the server MUST respond with HTTP 201

#### Scenario: Customer task with network project is rejected

- GIVEN `POST /api/scheduling` with `{ kind: 'customer', customerId: '<id>', contractId: '<id>', projectId: '<network-project-id>' }`
- AND the project has `isNetworkProject: true`
- WHEN the request is processed
- THEN the server MUST respond with HTTP 422
- AND the body MUST contain `{ "code": "INVALID_PROJECT_KIND" }`
- AND NO task MUST be persisted

#### Scenario: Customer task with customer project succeeds

- GIVEN `POST /api/scheduling` with `{ kind: 'customer', projectId: '<customer-project-id>' }`
- AND the project has `isNetworkProject: false`
- THEN the server MUST respond with HTTP 201

#### Scenario: Task with null projectId bypasses guard

- GIVEN `POST /api/scheduling` with `{ kind: 'network', networkSiteId: '<id>', projectId: null }`
- WHEN the request is processed
- THEN NO project-kind check MUST be performed
- AND the server MUST respond with HTTP 201 (existing REQ-CREATE-13 behavior)

#### Scenario: All projects start as isNetworkProject=false — existing customer tasks unaffected on deploy

- GIVEN ALL projects in the system have `isNetworkProject: false` (post-migration default)
- WHEN any existing customer task creation flow runs (no `projectId` override needed)
- THEN the guard MUST NOT reject any request (false is the correct value for customer projects)

---

### Requirement: REQ-PROJECT-KIND-GUARD-2 — Project-kind check order in CreateTask

The project-kind validation MUST occur AFTER the project FK lookup (the project must exist before its flag can be read). The order MUST be: project FK lookup → kind guard → persist. If the project does not exist, `PROJECT_NOT_FOUND` MUST be returned (REQ-CREATE-12 preserved).

#### Scenario: Non-existent project returns PROJECT_NOT_FOUND, not INVALID_PROJECT_KIND

- GIVEN `POST /api/scheduling` with `{ kind: 'network', projectId: 'fake-id' }`
- AND no project with `fake-id` exists
- THEN the server MUST respond with HTTP 404 `PROJECT_NOT_FOUND`
- AND NOT with HTTP 422 `INVALID_PROJECT_KIND`

---

## MODIFIED Requirements

### Requirement: REQ-LIST-1 — Returns all tasks as a JSON array (MODIFIED)

(Previously: no `kind` filter; returned all tasks unconditionally)

`GET /api/scheduling` MUST accept an optional `kind` query parameter. When omitted, ALL tasks are returned (behavior unchanged). When `kind` is provided and valid, only tasks of that kind are returned. Invalid `kind` values return 400.

#### Scenario: No kind param — all tasks returned (existing behavior)

- GIVEN authenticated `GET /api/scheduling` with no query params
- WHEN the repository contains both customer and network tasks
- THEN the server MUST respond with HTTP 200 with ALL tasks

#### Scenario: kind=network — only network tasks

- GIVEN authenticated `GET /api/scheduling?kind=network`
- THEN the response MUST contain only tasks where `kind='network'`

#### Scenario: Empty array when no tasks of requested kind

- GIVEN authenticated `GET /api/scheduling?kind=network`
- AND no network tasks exist
- THEN the server MUST respond with HTTP 200 and body `[]`

---

### Requirement: REQ-CREATE-12 — `CreateTask` project-kind validation added (MODIFIED)

(Previously: project FK lookup only — existence check, no kind check)

`CreateTask.execute` MUST:
1. Look up the project by `projectId` if non-null (existing behavior — PROJECT_NOT_FOUND if absent)
2. Verify project kind matches task kind (NEW — INVALID_PROJECT_KIND if mismatch)
3. Persist the task

Tasks with `projectId: null` bypass step 2 (unchanged).

#### Scenario: Existing flow — null projectId still accepted

- GIVEN `POST /api/scheduling` with `projectId: null` and `kind: 'customer'`
- THEN the server MUST respond with HTTP 201 (no project lookup, no kind check)

#### Scenario: Existing flow — non-existent projectId still returns 404

- GIVEN `POST /api/scheduling` with `projectId: 'does-not-exist'`
- THEN the server MUST respond with HTTP 404 `PROJECT_NOT_FOUND`

---

## Wire Contract

| Endpoint | New Param | Values | Notes |
|----------|-----------|--------|-------|
| `GET /api/scheduling` | `kind` | `'customer' \| 'network'` | Optional; omit = all |
| `POST /api/scheduling` | `projectId` (existing) | any | Guard checks `isNetworkProject` against `kind` |

Error codes added:

| Scenario | HTTP | `code` |
|----------|------|--------|
| `kind` param with invalid value | 400 | `VALIDATION_ERROR` |
| Project kind mismatch in CreateTask | 422 | `INVALID_PROJECT_KIND` |

Seam note: `#41` will add `status` filter to `ListTasksFilterSchema` and `buildFilterParams`. The `kind` key added here is orthogonal. Merge conflicts are possible in `scheduling.dto.ts`, `PrismaSchedulingRepository.ts`, `scheduling.ts` (types), and `scheduling.api.ts` — keep both changes strictly additive.
