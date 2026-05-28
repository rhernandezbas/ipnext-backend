# Delta Spec: task-project-reassign
# Capability: scheduling (MODIFIED)

**Change**: `task-project-reassign`
**Base spec**: `openspec/specs/scheduling/spec.md`
**Delta type**: additive — new REQs only; no existing REQs are modified or removed.

---

## Overview

`CreateTask` and `UpdateTask` currently accept any `projectId` value without validating the FK against the database — a non-existent `projectId` causes an untyped Prisma FK error that surfaces as HTTP 500. This delta hardens both use cases so that an invalid `projectId` produces a typed `ReferenceNotFoundError('project', id)`, which maps to HTTP 404 `PROJECT_NOT_FOUND`, consistent with how `customerId`, `serviceId`, `partnerId`, `reporterId`, and `assigneeId` are already validated. A missing or null `projectId` continues to be accepted without any lookup. The FE implications (editable project select in `DatosForm`, IClass warning) are documented in the informational FE section at the bottom of this file; their enforcement lives in the FE repo's Vitest tests, not in these BE Jest scenarios.

---

## New Requirements

### Section 4: Create Task — new REQs (continuing from REQ-CREATE-11)

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

### Section 5: Update Task — new REQs (continuing from REQ-UPDATE-4)

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

### Section: Reference error infrastructure

---

### REQ-REF-1: `ReferenceKind` includes `'project'` and `REFERENCE_TO_CODE` maps it to `'PROJECT_NOT_FOUND'`

**Given** the domain type `ReferenceKind` (in `src/domain/errors/scheduling.ts`)
**And** the route-level map `REFERENCE_TO_CODE` (in `src/infrastructure/http/routes/scheduling.routes.ts`)
**Then** `ReferenceKind` MUST include the literal `'project'`
**And** `REFERENCE_TO_CODE['project']` MUST equal `'PROJECT_NOT_FOUND'`
**And** the global `errorHandler` already maps `PROJECT_NOT_FOUND` → HTTP 404 (no change needed there)

This requirement ensures the error chain is fully wired:
`ReferenceNotFoundError('project', id)` → caught in route → `REFERENCE_TO_CODE['project']` → `'PROJECT_NOT_FOUND'` → HTTP 404.

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

## Error Contracts

| Trigger | Error class | HTTP | `code` |
|---------|-------------|------|--------|
| `projectId` present, non-null, non-empty, not found in lookup | `ReferenceNotFoundError('project', id)` | 404 | `PROJECT_NOT_FOUND` |
| `projectId: null` | no error | — | (passes through) |
| `projectId` absent (undefined) | no error | — | (passes through) |
| `projectId: ""` | coerced to null at route, no error | — | (passes through) |

The `errorHandler` already has `PROJECT_NOT_FOUND: 404` configured — this delta only wires the throw path.

Validation ordering (canonical, both CreateTask and UpdateTask):
```
customer → service → partner → project → reporter → assignee → watchers
```

---

## DTO / Schema Notes

- `UpdateTaskSchema.projectId` stays `z.string().nullable().optional()` — **no change**.
- `CreateTaskBaseSchema.projectId` stays `z.string().nullable().optional()` — **no change**.
- The intentional absence of `.min(1)` on `projectId` is preserved (per `task-detail-reporter-and-unified-save` archive decision). Empty-string normalization is handled at the **route level**, not inside the schema. This is the chosen approach over adding a Zod `.transform()` because:
  1. Keeps the schema change-free (no knock-on effects on `UpdateTaskSchema` which is a `.partial()` of the base).
  2. Is consistent with how the POST route already normalizes other nullable fields via `?? null`.
  3. Makes the normalization visible and testable at the HTTP boundary (supertest scenarios).

---

## FE Coverage (informational only — not enforceable by BE Jest tests)

The following behaviors are documented here for traceability. Their enforcement lives in `ipnext-frontend` Vitest tests.

- `DatosForm` renders a `<Select>` bound to `useProjects()`. The select is `required` at UI level (client-side validation blocks submit when empty).
- When `useProjects()` is loading, the select MUST be disabled.
- The derived state `showIClassWarning = task.iclassOrderCode != null && selectedProjectId !== task.projectId` controls an inline warning visible below the select: "Esta tarea ya tiene OS en IClass. El cambio no afecta la OS creada."
- The warning appears as soon as the user changes the select to a different project (or clears it) while `task.iclassOrderCode` is non-null; it disappears if the user reverts to the original value.
- Submit path: `projectId` travels in the existing `updateTask` payload — no new BE endpoint.
- `required` is client-side only; the BE schema keeps `projectId` nullable (legacy tasks have null; the follow-up of making the column NOT NULL is out of scope).

---

## Summary of New REQ IDs

| REQ ID | Section | Short description |
|--------|---------|-------------------|
| REQ-CREATE-12 | 4 — Create | Rejects invalid `projectId` → 404 `PROJECT_NOT_FOUND` |
| REQ-CREATE-13 | 4 — Create | Accepts null / absent `projectId` (no lookup) |
| REQ-CREATE-14 | 4 — Create | Coerces `projectId: ""` to null at route level |
| REQ-UPDATE-5  | 5 — Update | Rejects invalid `projectId` → 404 `PROJECT_NOT_FOUND` |
| REQ-UPDATE-6  | 5 — Update | Accepts `projectId: null` (clears assignment, no lookup) |
| REQ-UPDATE-7  | 5 — Update | FK validation BEFORE Prisma (no 500 from FK violation) |
| REQ-REF-1     | Ref infra | `ReferenceKind` + `REFERENCE_TO_CODE` include `'project'` |
