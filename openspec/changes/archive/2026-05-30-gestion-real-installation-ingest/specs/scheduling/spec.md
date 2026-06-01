# Delta for scheduling

**Change**: `gestion-real-installation-ingest`
**Base spec**: `openspec/specs/scheduling/spec.md`

The GR installation ingest creates `ScheduledTask`s programmatically. This delta adds an
idempotency key (`grOrdenId`) and formalizes that an ingest-created task MAY exist with no project
(needs-review state). No existing route behavior changes.

---

## ADDED Requirements

### Requirement: `ScheduledTask` carries a unique `grOrdenId` idempotency key

`ScheduledTask` MUST gain a `grOrdenId: string | null` field, persisted as a UNIQUE, NULLABLE
column via an ADDITIVE Prisma migration. It holds the Gestión Real order id for tasks created by
the ingest engine; manually created tasks leave it `null`. The uniqueness constraint MUST allow
multiple `null` rows (standard SQL NULL-distinct behavior) so that hand-made tasks are unaffected.

#### Scenario: Ingest-created task stores the GR order id

- GIVEN the ingest creates a task for GR order `551`
- WHEN the task is persisted
- THEN `grOrdenId` equals `"551"`

#### Scenario: Manually created task has null grOrdenId

- GIVEN a `POST /api/scheduling` request that does not set `grOrdenId`
- WHEN the task is created
- THEN the persisted task's `grOrdenId` is `null`

#### Scenario: Duplicate grOrdenId is rejected at the DB level

- GIVEN a task already exists with `grOrdenId = "551"`
- WHEN a second task with `grOrdenId = "551"` is attempted
- THEN the unique constraint prevents a duplicate (the ingest checks first and skips — see REQ-IDEMP-1 in gestion-real-ingest)

### Requirement: A `ScheduledTask` MAY be created with no project (needs-review state)

The ingest engine MAY create a `ScheduledTask` with `projectId = null` (the UNCLASSIFIED /
needs-review case). Such a task MUST be valid and persistable. Its `projectName` MUST serialize as
`null` (consistent with the existing nullable-project contract, REQ-NULL-8 / REQ-SHAPE-1).

#### Scenario: Needs-review task persists with null project

- GIVEN the ingest classifies an order as UNCLASSIFIED
- WHEN the task is created
- THEN the task persists with `projectId = null` and `projectName = null`
- AND no `PROJECT_NOT_FOUND` error is raised (no project lookup for a null id)

---

## MODIFIED Requirements

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
| `grOrdenId` | `string \| null` | Yes |

(Previously: identical table without the `grOrdenId` row; this delta adds `grOrdenId: string | null`.)
