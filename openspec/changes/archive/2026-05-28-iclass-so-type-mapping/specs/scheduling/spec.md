# Spec: Scheduling (Delta)

**Capability**: `scheduling` (MODIFIED)
**Change**: `iclass-so-type-mapping`
**Summary**: `SendTaskToIClass` resolves `soType` deterministically from `task.project.iclassSoType.code`. Two new domain errors cover the cases where the task has no project (`MissingProjectForIClassError`) or the project has no active IClass mapping (`MissingIClassMappingError`). The use case fails fast in both cases before any IClass call is made.

---

## Overview

The `SendTaskToIClass` use case previously used a hardcoded default SO type from the adapter. After this change it is the caller's responsibility that every task has a project with a valid IClass type mapping. The use case loads the project-with-SO-type in a single repository call, validates the mapping, and passes `soType` explicitly to `IClassPort.createServiceOrder`. If the mapping is absent or the mapped type is inactive, the operation fails with a typed error before IClass is contacted.

---

## 1. Domain Errors

### REQ-SCHED-ERR-1: `MissingProjectForIClassError`

A new domain error MUST exist in `src/domain/errors/`:

```ts
class MissingProjectForIClassError extends Error {
  readonly code = 'MISSING_PROJECT_FOR_ICLASS';
  constructor(taskId: string) { ... }
}
```

The HTTP handler MUST map this to HTTP 422 with `{ code: "MISSING_PROJECT_FOR_ICLASS" }`.

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

**Design decision — single error for inactive mapping**: An inactive `iclassSoTypeId` on the project at send-time is treated as a missing mapping and MUST throw `MissingIClassMappingError` (not a separate error). Rationale: from the operator's perspective both cases require the same corrective action — go to the Project and set/fix the IClass mapping. Introducing a separate `IClassSoTypeInactiveError` here would split the same user journey across two error codes. The `projectTitle` in the payload is sufficient for the FE to direct the operator. The inactive-type rejection at `PATCH /projects/:id` time (REQ-PROJ-3) is a separate guard with its own code (`ICLASS_SO_TYPE_INACTIVE`) because there the operator is explicitly interacting with the mapping — that distinction is meaningful.

---

## 2. Use Case — soType Resolution

### REQ-SCHED-1: Task must have a project for IClass send

**Given** a task with `projectId: null`
**And** the `iclass-integration` flag is ON
**When** `SendTaskToIClass.execute` is called
**Then** the use case MUST throw `MissingProjectForIClassError`
**And** NO call to `IClassPort` MUST be made
**And** the task stage MUST NOT change

#### Scenario: Task without project is rejected

**Given** a task `t-1` with `projectId: null`
**When** the stage-move endpoint is called for stage "Enviar a IClass" with flag ON
**Then** the server MUST respond HTTP 422 with `{ code: "MISSING_PROJECT_FOR_ICLASS" }`
**And** the task MUST remain in its current stage

### REQ-SCHED-2: Project must have an `iclassSoTypeId` set to a ACTIVE type

**Given** a task linked to project `p-1`
**And** `p-1.iclassSoTypeId` is `null`
**And** the flag is ON
**When** `SendTaskToIClass.execute` is called
**Then** the use case MUST throw `MissingIClassMappingError` with `projectTitle` equal to `p-1.title`
**And** NO call to `IClassPort` MUST be made

#### Scenario: Project without mapping is rejected

**Given** a task `t-1` linked to project `p-1` (title: "Cableado Norte")
**And** `p-1.iclassSoTypeId: null`
**When** the stage-move endpoint is called with flag ON
**Then** the server MUST respond HTTP 422 with `{ code: "MISSING_ICLASS_MAPPING", projectTitle: "Cableado Norte" }`
**And** the task MUST remain in its current stage

### REQ-SCHED-3: Project with inactive `iclassSoTypeId` is treated as missing mapping

**Given** a task linked to project `p-1`
**And** `p-1.iclassSoType.active` is `false`
**And** the flag is ON
**When** `SendTaskToIClass.execute` is called
**Then** the use case MUST throw `MissingIClassMappingError` with `projectTitle` equal to `p-1.title`
**And** NO call to `IClassPort` MUST be made

#### Scenario: Project with inactive type is rejected

**Given** a task `t-1` linked to project `p-1` (title: "Mantenimiento Sur")
**And** `p-1.iclassSoType: { code: "OLD_TYPE", active: false }`
**When** the stage-move endpoint is called with flag ON
**Then** the server MUST respond HTTP 422 with `{ code: "MISSING_ICLASS_MAPPING", projectTitle: "Mantenimiento Sur" }`

### REQ-SCHED-4: Valid mapping passes `soType` to `IClassPort.createServiceOrder`

**Given** a task `t-1` linked to project `p-1`
**And** `p-1.iclassSoType: { code: "INSTALACION FIBRA", active: true }`
**And** all 5 required fields (customerName, phone, address, city, description) are present
**And** the flag is ON
**When** `SendTaskToIClass.execute` is called
**Then** `IClassPort.createServiceOrder` MUST be called with `soType: "INSTALACION FIBRA"` in the input
**And** the task MUST advance to "Registrado en IClass" upon success

### REQ-SCHED-5: soType resolution is skipped when flag is OFF

**Given** the `iclass-integration` flag is OFF
**And** a task has `projectId: null`
**When** `SendTaskToIClass.execute` is called
**Then** the task MUST move to the target stage normally (no soType check, no IClass call)
**And** MUST NOT throw `MissingProjectForIClassError`

#### Scenario: Flag OFF bypasses all soType validation

**Given** any task regardless of `projectId` or `iclassSoTypeId`
**And** the flag is OFF
**When** the stage-move endpoint is called for "Enviar a IClass"
**Then** the server MUST respond HTTP 200 and move the task
**And** no domain errors related to project mapping MUST be thrown

---

## 3. Repository Contract

### REQ-SCHED-6: `SchedulingRepository.getTask` MUST include project with iclassSoType

**Given** a task with a linked project
**When** `SchedulingRepository.getTask(taskId)` is called
**Then** the returned `ScheduledTask` MUST include:
  - `projectId: string | null`
  - `project: { id, title, iclassSoTypeId, iclassSoType: { id, code, description, active } | null } | null`

The repository MUST eager-load the project and its `iclassSoType` relation in the same call. The use case MUST NOT issue a separate lookup for the project.

---

## Appendix: Error Contracts

| Error | HTTP | `code` | Extra fields |
|-------|------|--------|--------------|
| `MissingProjectForIClassError` | 422 | `MISSING_PROJECT_FOR_ICLASS` | — |
| `MissingIClassMappingError` | 422 | `MISSING_ICLASS_MAPPING` | `projectTitle` |

All existing error codes from the base `scheduling` spec (REQ-MOVE-VAL-1, REQ-MOVE-OS-1, etc.) remain unchanged.
