# Spec: closure-pending-list

Endpoint de solo-lectura que devuelve el listado de service orders con side-effects pendientes, enriquecidas con la tarea local vinculada.

## REQ-LIST-1 — Pending list endpoint

`GET /api/admin/iclass/closure/reprocess/pending-list` MUST return all service orders that have at least one pending side-effect (comment, inventory, or audit not done). Each item MUST include the side-effect flags from `IClassServiceOrder` and the linked task info (id, sequenceNumber, title) when a `scheduledTaskId` exists. The endpoint MUST be guarded by `auth` + `requireIClassManage`.

Response shape:

| Field | Type | Description |
|-------|------|-------------|
| `items` | array | Pending service orders |
| `items[].iclassId` | string | IClass OS identifier |
| `items[].scheduledTaskId` | string \| null | Linked local task id, or null |
| `items[].commentPosted` | boolean | Comment side-effect done |
| `items[].inventoryBuilt` | boolean | Inventory side-effect done |
| `items[].auditDone` | boolean | Audit side-effect done |
| `items[].auditAttempts` | number | Number of audit attempts made |
| `items[].task` | object \| null | Linked task info; null when `scheduledTaskId` is null |
| `items[].task.id` | string | Task UUID |
| `items[].task.sequenceNumber` | number | Task sequence number |
| `items[].task.title` | string | Task title |
| `total` | number | Total count of pending items |

#### Scenario: Happy path — pending SOs with linked tasks

- GIVEN there are 3 service orders with pending side-effects, all linked to tasks
- WHEN `GET /api/admin/iclass/closure/reprocess/pending-list` is called with a valid `iclass.manage` token
- THEN the server responds `200` with `{ items: [...], total: 3 }`
- AND each item includes `task.id`, `task.sequenceNumber`, and `task.title`

#### Scenario: Pending SO without linked task

- GIVEN a service order has `scheduledTaskId: null` and has pending side-effects
- WHEN `GET /api/admin/iclass/closure/reprocess/pending-list` is called
- THEN the item appears in `items` with `scheduledTaskId: null` and `task: null`
- AND `total` reflects this item

#### Scenario: Empty list when nothing is pending

- GIVEN all side-effects are complete (no pending items)
- WHEN `GET /api/admin/iclass/closure/reprocess/pending-list` is called
- THEN the server responds `200 { items: [], total: 0 }`

#### Scenario: Unauthenticated request

- GIVEN no valid auth token is provided
- WHEN `GET /api/admin/iclass/closure/reprocess/pending-list` is called
- THEN the server responds `401`

#### Scenario: Unauthorized — missing iclass.manage permission

- GIVEN a valid auth token without `iclass.manage` permission
- WHEN `GET /api/admin/iclass/closure/reprocess/pending-list` is called
- THEN the server responds `403`

## REQ-LIST-2 — Use case boundary mapping

`GetPendingSideEffectsList` MUST call the port method `listPendingSideEffectsWithTask(maxAuditAttempts)` and map the result to a DTO at the application boundary. It MUST NOT return raw Prisma entities. The `total` field MUST equal `items.length`.

#### Scenario: Use case maps port result to DTO

- GIVEN the port returns 2 items (one with a task, one without)
- WHEN `GetPendingSideEffectsList.execute()` is called
- THEN it returns `{ items: [...], total: 2 }` with both items correctly mapped
- AND the item without a task has `task: null`

## REQ-LIST-3 — FE progress table

The `ClosureProgressTable` component MUST render one row per pending OS. Each row MUST display: comment status (✓/✗), inventory status (✓/✗), audit status (✓/✗), audit attempt count, and a link to the task using `sequenceNumber` + `title`. When `task` is null the task-link cell MUST render an empty/dash placeholder. The table MUST render an empty-state message when the list is empty.

#### Scenario: Renders rows with task link

- GIVEN `usePendingList` returns 2 items both with linked tasks
- WHEN `ClosureProgressTable` mounts
- THEN it renders 2 rows, each with comment/inventory/audit indicators and a clickable task link

#### Scenario: Renders row without task link

- GIVEN an item has `task: null`
- WHEN `ClosureProgressTable` renders that row
- THEN the task-link cell renders a dash or placeholder (not a broken link)

#### Scenario: Empty state

- GIVEN `usePendingList` returns `{ items: [], total: 0 }`
- WHEN `ClosureProgressTable` renders
- THEN it displays an empty-state message (not an empty table body)

## REQ-LIST-4 — FE sub-tab restructure

`IClassSettingsBody` MUST expose exactly **5 sub-tabs**: Integración, Catálogo, Mapeo de proyectos, **Mapeo de estado**, and **Procesamiento**. The `cierre` sub-tab id MUST be preserved as-is or renamed to `procesamiento`; the label MUST change to `Procesamiento`. `IClassResultCodeMappingBody` MUST be mounted exclusively in the new `Mapeo de estado` sub-tab. `IClassClosureFlagBody` (+ `ClosureProgressTable`) MUST be mounted exclusively in the `Procesamiento` sub-tab. Deep-links that previously resolved to the `cierre` id MUST still resolve after the rename.

#### Scenario: 5 sub-tabs rendered

- GIVEN the IClass settings area mounts
- WHEN `IClassSettingsBody` renders
- THEN exactly 5 sub-tab labels are present: Integración, Catálogo, Mapeo de proyectos, Mapeo de estado, Procesamiento

#### Scenario: Mapeo de estado sub-tab mounts the mapping component

- GIVEN the user selects the `Mapeo de estado` sub-tab
- WHEN the tab content renders
- THEN `IClassResultCodeMappingBody` is mounted and `IClassClosureFlagBody` is NOT mounted in that tab

#### Scenario: Procesamiento sub-tab mounts closure controls + progress table

- GIVEN the user selects the `Procesamiento` sub-tab
- WHEN the tab content renders
- THEN `IClassClosureFlagBody` and `ClosureProgressTable` are both mounted
- AND `IClassResultCodeMappingBody` is NOT mounted in that tab
