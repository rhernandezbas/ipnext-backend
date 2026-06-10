# Task Manual Retiro — Specification

## Purpose

Adds manual equipment retirement from a task: a `Project` flag (`allowsEquipmentRetirement`) gates the feature per project; the task DTO exposes the flag; `POST /scheduling/:taskId/inventory/retire` atomically removes CIIs and returns assets to depot; the FE renders a picker in `InventoryPanel`.

## Requirements

### Requirement: Project Retirement Flag

`Project` MUST expose `allowsEquipmentRetirement: boolean` (DB default `false`). PATCH `/projects/:id` MUST accept `allowsEquipmentRetirement` in its body. This mutation MUST be gated with `inventory.manage` permission — the current PATCH only has `auth`; the retirement field MUST add a per-field or route-level `inventory.manage` guard. The field MUST be included in every Project response shape (GET list, GET by id, POST, PUT, PATCH).

#### Scenario: SCEN-MAP-1 — flag persists via PATCH with inventory.manage

- GIVEN project `P1` with `allowsEquipmentRetirement: false`
- WHEN `PATCH /api/projects/P1 { allowsEquipmentRetirement: true }` is called with `inventory.manage`
- THEN 200; `P1.allowsEquipmentRetirement === true`

#### Scenario: SCEN-MAP-2 — PATCH without inventory.manage is rejected

- GIVEN a user with `inventory.read` but not `inventory.manage`
- WHEN `PATCH /api/projects/P1 { allowsEquipmentRetirement: true }` is called
- THEN 403 is returned; the flag is unchanged

#### Scenario: SCEN-MAP-3 — all project responses include the flag

- GIVEN project `P1` with `allowsEquipmentRetirement: true`
- WHEN `GET /api/projects/P1` is called
- THEN the response MUST include `allowsEquipmentRetirement: true`

#### Scenario: SCEN-MAP-4 — new projects default to false

- GIVEN no precondition
- WHEN `POST /api/projects { title: 'Test' }` is called
- THEN the created project has `allowsEquipmentRetirement: false`

---

### Requirement: Task DTO — projectAllowsRetirement

The task DTO MUST expose `projectAllowsRetirement: boolean` (computed from the project JOIN, no extra RTT). Tasks with no project MUST return `false`. The Prisma mapper MUST include this field; the in-memory adapter MUST default it to `false`.

#### Scenario: SCEN-MAP-5 — task with mapped project exposes true

- GIVEN task `T1` belongs to project `P1` with `allowsEquipmentRetirement: true`
- WHEN `GET /api/scheduling/T1` is called
- THEN the response includes `projectAllowsRetirement: true`

#### Scenario: SCEN-MAP-6 — task with unmapped project exposes false

- GIVEN task `T2` belongs to project `P2` with `allowsEquipmentRetirement: false`
- WHEN `GET /api/scheduling/T2` is called
- THEN the response includes `projectAllowsRetirement: false`

#### Scenario: SCEN-MAP-7 — task without project exposes false

- GIVEN task `T3` has no `projectId`
- WHEN `GET /api/scheduling/T3` is called
- THEN the response includes `projectAllowsRetirement: false`

---

### Requirement: Retire Contract Equipment Endpoint

`POST /scheduling/:taskId/inventory/retire` (body `{ itemIds: string[] }`) MUST require `inventory.write`. Guards run in order before the transaction: (1) task exists, (2) task has `contractId`, (3) project has `allowsEquipmentRetirement === true`. Per-item inside a single `UnitOfWork.runInTransaction` (all-or-nothing): CII `active` + belongs to the task's contract; CII → `removed`; if `assetId` exists → RETURN movement (`source: 'MANUAL'`, `sourceRef: 'manual:retire:{taskId}:{ciiId}'`, `taskId`) + asset `available@DEPOSITO`. CIIs without `assetId` → CII removed, no movement. Idempotency guard via `sourceRef` on L2: re-retire of same CII → 409 `RETIRE_ALREADY_DONE`.

#### Scenario: SCEN-RET-1 — happy path: CII removed + asset returned atomically

- GIVEN task `T1` has `contractId: C1`, project `P1` with `allowsEquipmentRetirement: true`; CII `CII1` active, linked to `C1`, has `assetId: A1` (installed)
- WHEN `POST /scheduling/T1/inventory/retire { itemIds: ['CII1'] }` with `inventory.write`
- THEN 200; `CII1.status === 'removed'`; asset `A1.status === 'available'` at DEPOSITO; an `InventoryMovement` with `source='MANUAL'`, `taskId: T1`, `sourceRef: 'manual:retire:T1:CII1'` exists

#### Scenario: SCEN-RET-2 — N items retired atomically; one failure rolls back all

- GIVEN task `T1` / contract `C1`; CIIs `CII1` (active), `CII2` (active), `CII3` (removed)
- WHEN `POST /scheduling/T1/inventory/retire { itemIds: ['CII1','CII2','CII3'] }` with `inventory.write`
- THEN 409 (due to `CII3` already removed); `CII1` and `CII2` are NOT removed (full rollback)

#### Scenario: SCEN-RET-3 — CII without assetId (legacy): CII removed, no movement

- GIVEN CII `CII_LEG` active, `assetId: null`, belongs to `C1`
- WHEN `POST /scheduling/T1/inventory/retire { itemIds: ['CII_LEG'] }` with `inventory.write`
- THEN 200; `CII_LEG.status === 'removed'`; no `InventoryMovement` created for `CII_LEG`

#### Scenario: SCEN-RET-4 — CII belongs to a different contract → 422

- GIVEN CII `CII_OTHER` belongs to contract `C2` (not the task's contract `C1`)
- WHEN `POST /scheduling/T1/inventory/retire { itemIds: ['CII_OTHER'] }` with `inventory.write`
- THEN 422 `EQUIPMENT_NOT_ON_CONTRACT` is returned; no state is changed

#### Scenario: SCEN-RET-5 — re-retire same CII → 409 RETIRE_ALREADY_DONE

- GIVEN CII `CII1` was already retired (status `removed`, movement with sourceRef exists)
- WHEN `POST /scheduling/T1/inventory/retire { itemIds: ['CII1'] }` is called again
- THEN 409 `RETIRE_ALREADY_DONE` is returned

#### Scenario: SCEN-RET-6 — project not mapped → 422 PROJECT_NOT_RETIREMENT

- GIVEN task `T1` belongs to project `P2` with `allowsEquipmentRetirement: false`
- WHEN `POST /scheduling/T1/inventory/retire { itemIds: ['CII1'] }` with `inventory.write`
- THEN 422 `PROJECT_NOT_RETIREMENT` is returned; no state is changed

#### Scenario: SCEN-RET-7 — task without contractId → 422 TASK_HAS_NO_CONTRACT

- GIVEN task `T1` has `contractId: null`
- WHEN `POST /scheduling/T1/inventory/retire { itemIds: ['CII1'] }` with `inventory.write`
- THEN 422 `TASK_HAS_NO_CONTRACT` is returned

#### Scenario: SCEN-RET-8 — empty itemIds → 400

- GIVEN any valid task
- WHEN `POST /scheduling/T1/inventory/retire { itemIds: [] }` is called
- THEN 400 `VALIDATION_ERROR` is returned

#### Scenario: SCEN-RET-9 — inventory.write required

- GIVEN user has `inventory.read` but not `inventory.write`
- WHEN `POST /scheduling/T1/inventory/retire { itemIds: ['CII1'] }` is called
- THEN 403 is returned

---

### Requirement: Depot Reflects Retirement

After a successful retirement, the asset MUST appear as `available` at the DEPOSITO location. The ledger MUST record a RETURN movement with `from = CLIENTE`, `to = DEPOSITO`, `taskId`, `source = 'MANUAL'`.

#### Scenario: SCEN-DEP-1 — retired asset appears available at depot

- GIVEN CII `CII1` / asset `A1` just retired via `T1`
- WHEN `GET /api/inventory/depot` is called
- THEN `A1` appears in the depot stock with `status: available`

#### Scenario: SCEN-DEP-2 — ledger entry has correct source and taskId

- GIVEN asset `A1` retired via task `T1`
- WHEN the movement ledger is queried for `A1`
- THEN a RETURN movement exists with `source: 'MANUAL'`, `taskId: T1`, `from: CLIENTE`, `to: DEPOSITO`

---

### Requirement: Frontend — Retirement Picker in InventoryPanel

`InventoryPanel` in the task detail MUST render a "Retirar equipo" button only when `task.projectAllowsRetirement === true` AND the task has at least one active CII AND the user has `inventory.write`. Clicking opens a multi-select picker of active CIIs followed by a confirm-dialog. On confirm, calls `POST /scheduling/:taskId/inventory/retire`; on success, refetches the inventory panel and the sidebar. A task belonging to a project with `allowsEquipmentRetirement: false` MUST NOT render the button.

#### Scenario: SCEN-FE-1 — button visible when project mapped + active CIIs + permission

- GIVEN task `T1` with `projectAllowsRetirement: true`, active CIIs exist, user has `inventory.write`
- WHEN `InventoryPanel` renders
- THEN "Retirar equipo" button is visible

#### Scenario: SCEN-FE-2 — button hidden when project not mapped

- GIVEN task `T1` with `projectAllowsRetirement: false`
- WHEN `InventoryPanel` renders
- THEN "Retirar equipo" button is NOT rendered

#### Scenario: SCEN-FE-3 — button hidden when user lacks inventory.write

- GIVEN `projectAllowsRetirement: true`, active CIIs exist, but user lacks `inventory.write`
- WHEN `InventoryPanel` renders
- THEN "Retirar equipo" button is NOT rendered

#### Scenario: SCEN-FE-4 — picker shows active CIIs only

- GIVEN task `T1` has 2 active CIIs and 1 removed CII
- WHEN the picker is opened
- THEN only the 2 active CIIs are listed as selectable items

#### Scenario: SCEN-FE-5 — successful retirement triggers panel + sidebar refetch

- GIVEN the picker confirm-dialog is submitted with 1 CII selected
- WHEN the POST succeeds
- THEN `InventoryPanel` and the sidebar inventory section are refetched; the retired CII no longer appears active

#### Scenario: SCEN-FE-6 — backend error is shown as toast

- GIVEN the POST returns 422 `PROJECT_NOT_RETIREMENT`
- WHEN the dialog is submitted
- THEN a toast with the mapped Spanish error message is displayed; no state mutation occurs locally

---

### Requirement: Frontend — Retirement Projects Config Tab

`InventorySettingsPage` MUST include a "Proyectos de retiro" tab where operators with `inventory.manage` can toggle `allowsEquipmentRetirement` per project (inline auto-save, analogous to `IClassProjectMappingBody`). Users without `inventory.manage` MUST NOT see mutation controls.

#### Scenario: SCEN-FE-7 — config tab renders projects with toggle

- GIVEN user has `inventory.manage`
- WHEN the "Proyectos de retiro" tab is active
- THEN a list of projects is rendered, each with an `allowsEquipmentRetirement` toggle

#### Scenario: SCEN-FE-8 — toggle auto-saves via PATCH

- GIVEN the "Proyectos de retiro" tab is active
- WHEN the operator toggles `P1` to `true`
- THEN `PATCH /api/projects/P1 { allowsEquipmentRetirement: true }` is called with `inventory.manage`; on success the toggle stays checked

#### Scenario: SCEN-FE-9 — read-only user sees no toggles

- GIVEN user has `inventory.read` but not `inventory.manage`
- WHEN the "Proyectos de retiro" tab is active
- THEN toggles are absent or disabled; no PATCH calls are issued

---

## Routes Summary

| Method | Path | Permission | Success | Error codes |
|--------|------|-----------|---------|-------------|
| PATCH | `/api/projects/:id` | `inventory.manage` (for `allowsEquipmentRetirement` field) | 200 | 400, 403, 404 |
| POST | `/api/scheduling/:taskId/inventory/retire` | `inventory.write` | 200 | 400, 403, 409, 422 |

## Domain Errors

| Code | HTTP | Trigger |
|------|------|---------|
| `TASK_HAS_NO_CONTRACT` | 422 | Task has no `contractId` |
| `PROJECT_NOT_RETIREMENT` | 422 | Project has `allowsEquipmentRetirement: false` |
| `EQUIPMENT_NOT_ON_CONTRACT` | 422 | CII belongs to a different contract |
| `RETIRE_ALREADY_DONE` | 409 | `sourceRef` collision — CII already retired |
