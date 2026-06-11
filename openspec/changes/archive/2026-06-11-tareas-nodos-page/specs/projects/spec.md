# Delta for Projects

**Capability**: `projects`
**Type**: Delta (modifies existing spec at `openspec/specs/projects/spec.md`)
**Change**: `tareas-nodos-page` (#40)

---

## ADDED Requirements

### Requirement: REQ-PROJ-NET-1 — `Project` gains `isNetworkProject` boolean flag

The `Project` domain entity, Prisma schema, and all response DTOs MUST include `isNetworkProject: boolean`. The DB column MUST be added via an ADDITIVE migration with `@default(false)`. Existing rows gain `false` automatically; no data migration needed.

#### Scenario: Migration is additive — existing projects unaffected

- GIVEN the database has existing `Project` rows before the migration
- WHEN the migration `ALTER TABLE "Project" ADD COLUMN "isNetworkProject" BOOLEAN NOT NULL DEFAULT false` runs
- THEN all existing rows MUST have `isNetworkProject = false`
- AND no existing API behavior MUST change

#### Scenario: Newly created project defaults isNetworkProject to false

- GIVEN an authenticated `POST /api/projects` request with a valid body that omits `isNetworkProject`
- WHEN the request is processed
- THEN the server MUST respond with HTTP 201
- AND the returned project MUST have `isNetworkProject: false`

---

### Requirement: REQ-PROJ-NET-2 — All project responses include `isNetworkProject`

Every endpoint returning a `Project` object (GET list, GET by id, POST, PUT) MUST include `isNetworkProject: boolean` in the response. It MUST NOT be absent or `undefined`.

#### Scenario: GET /api/projects includes isNetworkProject on every item

- GIVEN an authenticated `GET /api/projects` request
- WHEN the response is received
- THEN every element in the array MUST have `isNetworkProject` as a boolean

#### Scenario: GET /api/projects/:id includes isNetworkProject

- GIVEN an authenticated `GET /api/projects/:id` request for an existing project
- WHEN the response is received
- THEN the body MUST include `isNetworkProject: boolean`

---

### Requirement: REQ-PROJ-NET-3 — PATCH `isNetworkProject` requires `scheduling.manage` permission

`PATCH /api/projects/:id` (or `PUT /api/projects/:id`) with `isNetworkProject` in the request body MUST be gated by the `scheduling.manage` permission. Requests that include `isNetworkProject` without this permission MUST be rejected with HTTP 403. Requests to the same endpoints that do NOT include `isNetworkProject` in the body MUST be unaffected by this guard (other fields update as before).

#### Scenario: PATCH isNetworkProject without scheduling.manage returns 403

- GIVEN an authenticated `PATCH /api/projects/:id` request
- AND the caller does NOT have `scheduling.manage`
- AND the body is `{ "isNetworkProject": true }`
- WHEN the request is processed
- THEN the server MUST respond with HTTP 403
- AND the project MUST NOT be modified

#### Scenario: PATCH isNetworkProject with scheduling.manage returns 200

- GIVEN an authenticated `PATCH /api/projects/:id` request
- AND the caller HAS `scheduling.manage`
- AND the body is `{ "isNetworkProject": true }`
- WHEN the request is processed
- THEN the server MUST respond with HTTP 200
- AND the returned project MUST have `isNetworkProject: true`

#### Scenario: PATCH other field without scheduling.manage is unaffected

- GIVEN an authenticated `PUT /api/projects/:id` request
- AND the caller does NOT have `scheduling.manage`
- AND the body is `{ "title": "New Title" }` (no `isNetworkProject`)
- WHEN the request is processed
- THEN the server MUST respond with HTTP 200 (existing auth/perm behavior unchanged)

#### Scenario: PATCH isNetworkProject to false disables network flag

- GIVEN a project with `isNetworkProject: true`
- AND the caller HAS `scheduling.manage`
- AND the body is `{ "isNetworkProject": false }`
- WHEN the request is processed
- THEN the server MUST respond with HTTP 200
- AND the returned project MUST have `isNetworkProject: false`

---

### Requirement: REQ-PROJ-NET-4 — "Proyectos de red" sub-tab in Scheduling Settings UI

The `SchedulingSettingsPage` MUST include a sub-tab "Proyectos de red" (mirroring the pattern of `RetirementProjectsBody` for `allowsEquipmentRetirement`). This tab MUST be gated by `scheduling.manage`. It MUST list all projects and allow toggling `isNetworkProject` per project.

#### Scenario: scheduling.manage user sees Proyectos de red tab

- GIVEN a user with `scheduling.manage`
- WHEN they navigate to `/admin/scheduling/settings`
- THEN a tab "Proyectos de red" MUST be visible
- AND it MUST list projects with a toggle for `isNetworkProject`

#### Scenario: User without scheduling.manage does not see the tab

- GIVEN a user without `scheduling.manage`
- WHEN they navigate to `/admin/scheduling/settings`
- THEN the "Proyectos de red" tab MUST be absent or disabled

---

## MODIFIED Requirements

### Requirement: REQ-SHAPE-1 — Project response object structure (MODIFIED)

(Previously: no `isNetworkProject` field)

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
| `isNetworkProject` | `boolean` | No |
| `partners` | `Array<{ id: string, name: string }>` | No (MAY be empty) |
| `taskCounts` | `{ nuevo: number, enProgreso: number, hecho: number, total: number }` | No |
| `iclassSoTypeId` | `string \| null` | Yes |
| `iclassSoType` | `{ id, code, description, active } \| null` | Yes |
| `createdAt` | `string` (ISO 8601) | No |
| `updatedAt` | `string` (ISO 8601) | No |

#### Scenario: Wire contract — isNetworkProject field

- GIVEN `GET /api/projects` returns a list
- THEN each item MUST satisfy: `typeof item.isNetworkProject === 'boolean'`
- AND the field MUST be `false` for all projects that have never been tagged

---

### Requirement: REQ-VAL-1 — `CreateProjectSchema` shape (MODIFIED)

(Previously: no `isNetworkProject` field)

`CreateProjectSchema` MUST add:
- `isNetworkProject`: `z.boolean().optional()` — defaults to `false` when omitted

#### Scenario: isNetworkProject omitted in create — defaults to false

- GIVEN `POST /api/projects` body without `isNetworkProject`
- THEN the project is created with `isNetworkProject: false`

---

### Requirement: REQ-VAL-2 — `UpdateProjectSchema` (MODIFIED)

(Previously: no `isNetworkProject` field)

`UpdateProjectSchema` MUST add:
- `isNetworkProject`: `z.boolean().optional()`

Non-boolean values for `isNetworkProject` MUST be rejected with 400 `VALIDATION_ERROR`.

#### Scenario: Non-boolean isNetworkProject in PATCH returns 400

- GIVEN `PATCH /api/projects/:id` body `{ "isNetworkProject": "yes" }`
- THEN the server MUST respond with HTTP 400
- AND the body MUST contain `{ "code": "VALIDATION_ERROR" }`

---

## Wire Contract

| Endpoint | Body | Required Permission | Response |
|----------|------|---------------------|----------|
| `GET /api/projects` | — | auth only | Array includes `isNetworkProject: boolean` |
| `PATCH /api/projects/:id` | `{ isNetworkProject: boolean }` | `scheduling.manage` | 200 updated Project / 403 without perm |
| `PUT /api/projects/:id` | `{ isNetworkProject: boolean }` | `scheduling.manage` when field present | 200 / 403 |

Error codes added:

| Scenario | HTTP | `code` |
|----------|------|--------|
| `isNetworkProject` in body without `scheduling.manage` | 403 | `FORBIDDEN` |
| Non-boolean `isNetworkProject` | 400 | `VALIDATION_ERROR` |
