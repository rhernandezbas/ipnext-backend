# Spec: Projects (Delta)

**Capability**: `projects` (MODIFIED)
**Change**: `iclass-so-type-mapping`
**Summary**: `Project` gains an optional FK `iclassSoTypeId` pointing to `IClassSoType`. `PATCH /api/projects/:id` (or `PUT`) accepts this field. Assigning an inactive type ID is rejected with 422. Clearing the mapping (passing `null`) is allowed.

---

## Overview

A Project can be linked to exactly one IClass SO type at a time (or none). The mapping is nullable because the catalog may not be seeded when Projects are created, and operators assign mappings manually. The FK is optional — not required for Project creation or update — so the Projects capability remains fully functional without the catalog.

---

## 1. Domain Model

### REQ-PROJ-1: `Project` entity gains `iclassSoTypeId` and `iclassSoType`

The `Project` entity MUST be extended with:

```ts
interface Project {
  // ... existing fields ...
  iclassSoTypeId: string | null;
  iclassSoType: { id: string; code: string; description: string; active: boolean } | null;
}
```

`iclassSoType` is included when the repository eager-loads the relation. Use cases that return `Project` MUST propagate both fields.

### REQ-PROJ-2: `UpdateProjectInput` accepts `iclassSoTypeId`

The `UpdateProjectInput` port input MUST include:

```ts
interface UpdateProjectInput {
  // ... existing optional fields ...
  iclassSoTypeId?: string | null;
}
```

Passing `null` explicitly clears the mapping. Omitting the field leaves the existing mapping unchanged.

---

## 2. Validation

### REQ-PROJ-3: Assigning an inactive `iclassSoTypeId` is rejected

**Given** a `PATCH /api/projects/:id` (or `PUT`) request with `iclassSoTypeId: "<id-of-inactive-type>"`
**When** the use case resolves the type via `IClassSoTypeRepository.getById(id)`
**And** the resolved entry has `active: false`
**Then** the use case MUST throw `IClassSoTypeInactiveError`
**And** the HTTP handler MUST respond HTTP 422 with `{ code: "ICLASS_SO_TYPE_INACTIVE", iclassSoTypeId: "<id>" }`

#### Scenario: Inactive type rejected on update

**Given** an `IClassSoType` entry with `id: "t-1"`, `code: "OLD_TYPE"`, `active: false`
**And** a `PATCH /api/projects/p-1` request body `{ "iclassSoTypeId": "t-1" }`
**When** processed
**Then** the server MUST respond HTTP 422 with `{ code: "ICLASS_SO_TYPE_INACTIVE" }`
**And** the project MUST NOT be modified

### REQ-PROJ-4: Assigning a non-existent `iclassSoTypeId` is rejected

**Given** a `PATCH /api/projects/:id` request with `iclassSoTypeId: "<unknown-id>"`
**When** `IClassSoTypeRepository.getById(id)` returns `null`
**Then** the use case MUST throw `IClassSoTypeNotFoundError` (or the general `ReferenceNotFoundError` with kind `iclassSoType`)
**And** the HTTP handler MUST respond HTTP 404 with `{ code: "ICLASS_SO_TYPE_NOT_FOUND" }`

#### Scenario: Unknown type ID rejected on update

**Given** no `IClassSoType` exists with `id: "t-999"`
**And** a `PATCH /api/projects/p-1` body `{ "iclassSoTypeId": "t-999" }`
**When** processed
**Then** the server MUST respond HTTP 404 with `{ code: "ICLASS_SO_TYPE_NOT_FOUND" }`
**And** the project MUST NOT be modified

### REQ-PROJ-5: Setting `iclassSoTypeId: null` clears the mapping

**Given** a project `p-1` with `iclassSoTypeId: "t-1"` (active)
**And** a `PATCH /api/projects/p-1` body `{ "iclassSoTypeId": null }`
**When** processed
**Then** the server MUST respond HTTP 200
**And** the returned project MUST have `iclassSoTypeId: null` and `iclassSoType: null`

### REQ-PROJ-6: Active type is accepted and persisted

**Given** an `IClassSoType` entry with `id: "t-2"`, `code: "INSTALACION FIBRA"`, `active: true`
**And** a `PATCH /api/projects/p-1` body `{ "iclassSoTypeId": "t-2" }`
**When** processed
**Then** the server MUST respond HTTP 200
**And** the returned project MUST have `iclassSoTypeId: "t-2"`
**And** `iclassSoType.code` MUST equal `"INSTALACION FIBRA"`

---

## 3. HTTP

### REQ-PROJ-7: `PATCH /api/projects/:id` is the write surface for IClass mapping

The route MUST accept `iclassSoTypeId` as an optional nullable string in the request body schema. Existing `PUT /api/projects/:id` MUST also accept it (same schema extension). Validation MUST reject non-string, non-null values for this field (400 `VALIDATION_ERROR`).

#### Scenario: Invalid type for iclassSoTypeId returns 400

**Given** a `PATCH /api/projects/p-1` body `{ "iclassSoTypeId": 123 }`
**When** processed
**Then** the server MUST respond HTTP 400 with `{ code: "VALIDATION_ERROR" }`

---

## 4. Response Shape

### REQ-PROJ-8: All project responses include `iclassSoTypeId` and `iclassSoType`

Every endpoint that returns a `Project` (GET list, GET by id, POST, PUT, PATCH) MUST include:

| Field | Type | Nullable |
|-------|------|----------|
| `iclassSoTypeId` | `string \| null` | Yes |
| `iclassSoType` | `{ id, code, description, active } \| null` | Yes |

`iclassSoType` MUST be `null` when `iclassSoTypeId` is `null`. It MUST be the full inline object (not just the ID) when set.

---

## Appendix: Error Contracts

| Error | HTTP | `code` |
|-------|------|--------|
| `IClassSoTypeInactiveError` | 422 | `ICLASS_SO_TYPE_INACTIVE` (+ `iclassSoTypeId`) |
| `IClassSoTypeNotFoundError` | 404 | `ICLASS_SO_TYPE_NOT_FOUND` |
| Zod validation failure | 400 | `VALIDATION_ERROR` |
| Project not found | 404 | `PROJECT_NOT_FOUND` |
