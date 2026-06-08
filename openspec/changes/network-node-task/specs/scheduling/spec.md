# Delta for Scheduling

**Change**: `network-node-task`
**Capabilities modified**: `scheduling`

---

## ADDED Requirements

### Requirement: REQ-KIND-1 — Network task creation succeeds without customer/contract

A `POST /api/scheduling` request with `kind: 'network'` and a valid `networkSiteId` MUST succeed and create a task with `customerId: null`, `contractId: null`, and the provided `networkSiteId`.

#### Scenario: Network task created successfully

- GIVEN an authenticated `POST /api/scheduling` request
- AND the body contains `{ kind: 'network', networkSiteId: '<existing-id>', title: '...', ... }` with no `customerId` or `contractId`
- WHEN the request is processed
- THEN the server MUST respond with HTTP 201
- AND the body MUST contain `kind: 'network'`, `networkSiteId: '<id>'`, `customerId: null`, `contractId: null`
- AND `networkSiteName` MUST be the name of the referenced NetworkSite

#### Scenario: Network task payload regression — customer task unchanged

- GIVEN an authenticated `POST /api/scheduling` request
- AND the body contains `{ kind: 'customer', customerId: '<id>', contractId: '<id>', ... }`
- WHEN the request is processed
- THEN the server MUST respond with HTTP 201 with behavior byte-identical to the pre-change path
- AND `networkSiteId` MUST be `null` in the response

---

### Requirement: REQ-KIND-2 — Network task with missing networkSiteId is rejected

When `kind: 'network'` is sent without `networkSiteId` (absent, null, or empty string), the schema discriminated union MUST reject the request at the validation layer.

#### Scenario: Missing networkSiteId returns 400

- GIVEN a `POST /api/scheduling` body with `{ kind: 'network' }` and no `networkSiteId`
- WHEN the request is processed
- THEN the server MUST respond with HTTP 400
- AND the body MUST contain `{ "code": "VALIDATION_ERROR" }`
- AND the task MUST NOT be persisted

#### Scenario: Discriminated union rejects mixing — customer fields in network mode

- GIVEN a `POST /api/scheduling` body with `{ kind: 'network', networkSiteId: '<id>', customerId: '<cust-id>' }`
- WHEN the Zod schema validates the input
- THEN validation MUST fail with `VALIDATION_ERROR` (customer fields not allowed in network mode)

---

### Requirement: REQ-KIND-3 — Network task with non-existent networkSiteId returns 404/422

When `kind: 'network'` is submitted with a well-formed but non-existent `networkSiteId`, the use case MUST reject it with `ReferenceNotFoundError`.

#### Scenario: Non-existent networkSiteId returns 404

- GIVEN a `POST /api/scheduling` body with `{ kind: 'network', networkSiteId: 'does-not-exist' }`
- AND no NetworkSite with that id exists
- WHEN the request is processed
- THEN the server MUST respond with HTTP 404 or 422
- AND the body MUST contain `{ "code": "REFERENCE_NOT_FOUND" }` or `"NETWORK_SITE_NOT_FOUND"`
- AND the task MUST NOT be persisted

---

## MODIFIED Requirements

### Requirement: REQ-SHAPE-2 — Task object field structure

(Previously: no `kind`, `networkSiteId`, or `networkSiteName` fields on the task response shape)

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
| `serviceId` | `string` | No |
| `status` | `'pending' \| 'in_progress' \| 'completed' \| 'cancelled'` (deprecated) | No |
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

#### Scenario: Network task response exposes kind and site fields

- GIVEN a previously created task with `kind: 'network'` and `networkSiteId` set
- WHEN `GET /api/scheduling/:id` is called
- THEN `kind` MUST equal `'network'`
- AND `networkSiteId` MUST be the stored value
- AND `networkSiteName` MUST be the name of the referenced NetworkSite (JOIN-derived)
- AND `customerId` MUST be `null`

#### Scenario: Customer task response has kind='customer' and null network fields

- GIVEN a task created with `kind: 'customer'`
- WHEN any endpoint returns the task
- THEN `kind` MUST equal `'customer'`
- AND `networkSiteId` MUST be `null`
- AND `networkSiteName` MUST be `null`

---

### Requirement: REQ-VAL-1 — `CreateTaskSchema` is a discriminated union on `kind`

(Previously: flat schema requiring `customerId` and `contractId` unconditionally)

`CreateTaskSchema` MUST be a `z.discriminatedUnion('kind', [...])` with two branches:

- `CustomerTask`: `kind: z.literal('customer')`, `customerId: z.string().min(1)`, `contractId: z.string().min(1)`, no `networkSiteId`
- `NetworkTask`: `kind: z.literal('network')`, `networkSiteId: z.string().min(1)`, `customerId: z.null().optional()`, `contractId: z.null().optional()`

Both branches MUST share a base schema containing: `title`, `priority`, `estimatedHours`, `category`, `stageId` (optional), `serviceId`, `startDate`, `endDate`, and all other non-mode-specific fields.

#### Scenario: Customer task schema rejects missing contract

- GIVEN `{ kind: 'customer', customerId: 'c-1' }` with no `contractId`
- WHEN Zod validates
- THEN result MUST be invalid with `VALIDATION_ERROR`

#### Scenario: Network task schema rejects missing networkSiteId

- GIVEN `{ kind: 'network' }` with no `networkSiteId`
- WHEN Zod validates
- THEN result MUST be invalid with `VALIDATION_ERROR`

---

## ADDED Requirements — Reference Infrastructure

### Requirement: REQ-REF-NETWORK-1 — `ReferenceKind` includes `'networkSite'`

`ReferenceKind` in `src/domain/errors/scheduling.ts` MUST include the literal `'networkSite'`.
`REFERENCE_TO_CODE['networkSite']` in `scheduling.routes.ts` MUST map to `'NETWORK_SITE_NOT_FOUND'`.
The global error handler MUST map `NETWORK_SITE_NOT_FOUND` → HTTP 404.

#### Scenario: Full error chain for non-existent networkSiteId

- GIVEN `CreateTask.execute` throws `ReferenceNotFoundError('networkSite', '<id>')`
- WHEN the route catches the error
- THEN `REFERENCE_TO_CODE['networkSite']` resolves to `'NETWORK_SITE_NOT_FOUND'`
- AND the response is HTTP 404

---

## Appendix: New Error Codes

| Scenario | HTTP | `code` |
|----------|------|--------|
| Non-existent `networkSiteId` | 404 | `NETWORK_SITE_NOT_FOUND` |
| Invalid discriminated kind | 400 | `VALIDATION_ERROR` |
