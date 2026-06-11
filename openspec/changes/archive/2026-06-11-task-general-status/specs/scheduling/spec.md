# Delta for scheduling

**Capability**: `scheduling` (MODIFIED)
**Change**: `task-general-status` (#41)

---

## ADDED Requirements

### Requirement: REQ-GS-FILTER-1 — `status` query parameter filters by generalStatus

`GET /api/scheduling` MUST accept an optional `status` query parameter with values `open | closed | dismissed | all`. When omitted, ALL tasks are returned (`≡ all`, back-compat — no caller breaks). When provided, only tasks with the matching `generalStatus` are returned. `all` returns all tasks regardless of status. This is additive and orthogonal to `kind`, `search`, `priority`, `projectId`.

| `status` param | Behavior |
|----------------|----------|
| omitted | return all (same as today — back-compat) |
| `all` | return all explicitly |
| `open` | `generalStatus = 'open'` only |
| `closed` | `generalStatus = 'closed'` only |
| `dismissed` | `generalStatus = 'dismissed'` only |
| any other value | HTTP 400 `VALIDATION_ERROR` |

#### Scenario: Default (omitted) returns all tasks

- GIVEN tasks exist with `generalStatus='open'`, `'closed'`, `'dismissed'`
- WHEN `GET /api/scheduling` with no `status` param
- THEN all three MUST appear in the response (back-compat preserved)

#### Scenario: status=open filters to open only

- GIVEN tasks exist with multiple statuses
- WHEN `GET /api/scheduling?status=open`
- THEN response MUST contain only tasks with `generalStatus='open'`

#### Scenario: status=closed filters to closed only

- WHEN `GET /api/scheduling?status=closed`
- THEN response MUST contain only tasks with `generalStatus='closed'`

#### Scenario: status=dismissed filters to dismissed only

- WHEN `GET /api/scheduling?status=dismissed`
- THEN response MUST contain only tasks with `generalStatus='dismissed'`

#### Scenario: status=all returns all tasks (explicit)

- WHEN `GET /api/scheduling?status=all`
- THEN response MUST contain tasks of all three generalStatus values

#### Scenario: Invalid status value

- WHEN `GET /api/scheduling?status=archived`
- THEN server MUST respond HTTP 400 `{ code: 'VALIDATION_ERROR' }`

#### Scenario: status combines with kind

- WHEN `GET /api/scheduling?status=open&kind=network`
- THEN response MUST contain only tasks where `generalStatus='open'` AND `kind='network'`

#### Scenario: status combines with search

- WHEN `GET /api/scheduling?status=closed&q=fibra`
- THEN response MUST contain only tasks where `generalStatus='closed'` AND title matches 'fibra'

#### Scenario: status combines with priority

- WHEN `GET /api/scheduling?status=open&priority=high`
- THEN response MUST contain only tasks where `generalStatus='open'` AND `priority='high'`

#### Scenario: status combines with projectId

- WHEN `GET /api/scheduling?status=open&projectId=<p>`
- THEN response MUST contain only tasks where `generalStatus='open'` AND `projectId=<p>`

---

## MODIFIED Requirements

### Requirement: REQ-SHAPE-2 — Task object field structure (MODIFIED)

Every `ScheduledTask` response object MUST contain at minimum the following fields:

(Previously: no `generalStatus` field; `isClosed` not listed)

| Field | Type | Nullable |
|-------|------|----------|
| `id` | `string` | No |
| `title` | `string` | No |
| `description` | `string \| null` | Yes |
| `assignedTo` | `string \| null` | Yes |
| `assignedToId` | `string \| null` | Yes |
| `clientId` | `string \| null` | Yes |
| `clientName` | `string \| null` | Yes |
| `serviceId` | `string` | No |
| `status` | `'pending' \| 'in_progress' \| 'completed' \| 'cancelled'` (deprecated) | No |
| `generalStatus` | `'open' \| 'closed' \| 'dismissed'` | No |
| `isClosed` | `boolean` | No |
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
| `kind` | `'customer' \| 'network'` | No |
| `networkSiteId` | `string \| null` | Yes |
| `networkSiteName` | `string \| null` | Yes |
| `stageId` | `string` | No |
| `stageCategory` | `'nuevo' \| 'enProgreso' \| 'hecho'` | No |
| `reviewedByInventory` | `boolean` | No |

#### Scenario: Response shape includes new fields

- GIVEN any authenticated request that returns a `ScheduledTask`
- WHEN the response is received
- THEN `generalStatus` MUST be one of `'open' | 'closed' | 'dismissed'`
- AND `isClosed` MUST equal `generalStatus === 'closed'`
