# Spec: ne8000-audit-api

**Capability**: `ne8000-audit-api`
**Type**: New (read-only use case + HTTP route)
**Change**: `network-audit-pages`
**Use case**: `src/application/use-cases/ListNe8000PppoeAudit.ts`
**DTO**: `src/application/dto/ne8000-audit.dto.ts` (or part of `radius-event.dto.ts`)
**Route**: `GET /radius/ne8000/audit` in `src/infrastructure/http/routes/radius.routes.ts` (or `network-audit.routes.ts`)
**Permission**: `network.read`

> READ-ONLY by design. This endpoint provides the padrón of PPPoE services terminating on
> the NE8000 BRAS, enriched with last-connection data from `RadiusEvent`.
> NO mutations. The PPPoE management flow (enable/disable/block) is out of scope for this EPIC.

---

## 1. Authentication and Authorization

### REQ-AUTH-1: Unauthenticated request is rejected

**Given** a request to `GET /radius/ne8000/audit` without an `auth_token` cookie
**When** the request is received
**Then** the server MUST respond with HTTP 401
**And** the body MUST contain `{ "code": "UNAUTHORIZED" }`

### REQ-RBAC-1: `network.read` permission required

**Given** an authenticated user without `network.read` in their effective permissions
**When** they request `GET /radius/ne8000/audit`
**Then** the server MUST respond with HTTP 403
**And** the body MUST contain `{ "code": "FORBIDDEN" }`

#### Scenario: admin with network.read succeeds

**Given** an admin user with `network.read`
**When** they request `GET /radius/ne8000/audit`
**Then** the server MUST respond with HTTP 200

---

## 2. Data Model — Padrón PPPoE of the NE8000

### REQ-DATA-1: Only `PppoeService` rows belonging to the NE8000 NAS are included

**Given** the NE8000 `NasServer` row registered by `ne8000-nas-registration`
**When** `ListNe8000PppoeAudit` queries `PppoeService`
**Then** it MUST filter: `PppoeService.nasId = <NE8000 NasServer.id>`
**And** services belonging to MikroTik or other NAS servers MUST NOT appear

#### Scenario: MikroTik PPPoE services excluded

**Given** `PppoeService` table contains rows for both MikroTik (nasId=A) and NE8000 (nasId=B)
**When** `GET /radius/ne8000/audit` is called
**Then** the response data MUST contain only rows with `nasId = B`

### REQ-DATA-2: Last connection enriched from `RadiusEvent`

**Given** a `PppoeService` with `username = 'c001'`
**And** `RadiusEvent` contains events for `username = 'c001'` (both active and closed)
**When** `ListNe8000PppoeAudit` builds the result
**Then** each audit row MUST include:
- `lastStartedAt` — `startedAt` of the most recent `RadiusEvent` for that username (regardless of `eventType`)
- `lastStoppedAt` — `stoppedAt` of the most recent CLOSED `RadiusEvent` for that username (`stoppedAt IS NOT NULL`)
- `currentlyOnline` — `true` if there exists a `RadiusEvent` for that username with `stoppedAt IS NULL`

**And** if no `RadiusEvent` exists for the username, all three fields MUST be `null` / `false`

#### Scenario: PPPoE with no history

**Given** `PppoeService` row for `username = 'new-user'` with no `RadiusEvent` entries
**When** the audit builds the result
**Then** `lastStartedAt = null`, `lastStoppedAt = null`, `currentlyOnline = false`

#### Scenario: PPPoE with history, currently online

**Given** `RadiusEvent` rows for `username = 'c001'`:
  - Row 1: `startedAt = T1, stoppedAt = T2` (closed)
  - Row 2: `startedAt = T3, stoppedAt = null` (active)
**When** the audit builds the result
**Then** `lastStartedAt = T3`, `lastStoppedAt = T2`, `currentlyOnline = true`

---

## 3. Query Parameters and Filtering

### REQ-FILTER-1: All filters are optional

**Given** a request to `GET /radius/ne8000/audit` with no query parameters
**When** the server processes the request
**Then** it MUST return the full NE8000 padrón (paginated, default limit) with HTTP 200

### REQ-FILTER-2: `username` filter

**Given** a request to `GET /radius/ne8000/audit?username=c001`
**When** the use case queries
**Then** it MUST return only rows where `PppoeService.username ILIKE '%c001%'`

### REQ-FILTER-3: `status` filter — PPPoE operational status

**Given** a request to `GET /radius/ne8000/audit?status=enabled`
**When** the use case queries
**Then** it MUST return only `PppoeService` rows where `status = 'enabled'`

**Given** a request to `GET /radius/ne8000/audit?status=disabled`
**When** the use case queries
**Then** it MUST return only rows where `status = 'disabled'`

**And** accepted values: `enabled | disabled` — any other value MUST return HTTP 400

### REQ-FILTER-4: `enforcedState` filter

**Given** a request to `GET /radius/ne8000/audit?enforcedState=blocked`
**When** the use case queries
**Then** it MUST return only rows where `PppoeService.enforcedState = 'blocked'`

**And** accepted values: `active | reduced | blocked` — any other value MUST return HTTP 400

### REQ-FILTER-5: `online` filter — currently connected

**Given** a request to `GET /radius/ne8000/audit?online=true`
**When** the use case queries
**Then** it MUST return only rows where `currentlyOnline = true` (i.e. username has an active `RadiusEvent`)

**Given** a request to `GET /radius/ne8000/audit?online=false`
**When** the use case queries
**Then** it MUST return only rows where `currentlyOnline = false`

---

## 4. Pagination

### REQ-PAGE-1: `page` and `limit` query params

**Given** a request to `GET /radius/ne8000/audit?page=1&limit=50`
**When** the use case queries
**Then** it MUST return the first 50 results
**And** `page` MUST default to 1
**And** `limit` MUST default to 50, capped at 200

### REQ-PAGE-2: Paginated response envelope

**Given** a successful `GET /radius/ne8000/audit` request
**When** the server responds with HTTP 200
**Then** the body MUST include:

| Field | Type |
|-------|------|
| `data` | `Ne8000AuditRowDTO[]` |
| `total` | `number` |
| `page` | `number` |
| `limit` | `number` |
| `hasNext` | `boolean` |

### REQ-PAGE-3: Empty padrón is valid

**Given** no `PppoeService` rows exist for the NE8000 NAS
**When** `GET /radius/ne8000/audit` is called
**Then** the server MUST return HTTP 200 with `{ data: [], total: 0, page: 1, limit: 50, hasNext: false }`
**And** MUST NOT return HTTP 404

---

## 5. Response DTO

### REQ-DTO-1: `Ne8000AuditRowDTO` shape — no raw Prisma entities

**Given** the hexagonal convention
**When** `ListNe8000PppoeAudit` maps results
**Then** each item MUST be a `Ne8000AuditRowDTO`:

| Field | Type | Source |
|-------|------|--------|
| `pppoeId` | `string` | `PppoeService.id` |
| `username` | `string` | `PppoeService.username` |
| `profile` | `string \| null` | `PppoeService.profile` (plan/group name) |
| `remoteAddress` | `string \| null` | `PppoeService.remoteAddress` (fixed IP) |
| `macAddress` | `string \| null` | `PppoeService.callerId` (last known MAC) |
| `status` | `string` | `PppoeService.status` (`enabled \| disabled`) |
| `enforcedState` | `string` | `PppoeService.enforcedState` (`active \| reduced \| blocked`) |
| `contractId` | `string \| null` | `PppoeService.contractId` |
| `currentlyOnline` | `boolean` | Derived from `RadiusEvent` (see REQ-DATA-2) |
| `lastStartedAt` | `string \| null` | ISO 8601, from latest `RadiusEvent.startedAt` |
| `lastStoppedAt` | `string \| null` | ISO 8601, from latest closed `RadiusEvent.stoppedAt` |
| `lastFramedIp` | `string \| null` | `framedIp` of the most recent `RadiusEvent` for this username |
| `lastVlanId` | `number \| null` | `vlanId` of the most recent `RadiusEvent` for this username |

**And** `pppoeId` is included so the FE can build deep-links if needed (read-only, no mutation)

### REQ-DTO-2: Sensitive fields are NOT exposed

**Given** `PppoeService.password` stores the PPPoE password
**When** the DTO is mapped
**Then** `password` MUST NOT appear in `Ne8000AuditRowDTO`
**And** `PppoeService.radiusSecret` (if any) MUST NOT appear

---

## 6. Use Case

### REQ-UC-1: `ListNe8000PppoeAudit` lives in application layer

**Given** the DIP convention
**When** implemented
**Then** it MUST live in `src/application/use-cases/ListNe8000PppoeAudit.ts`
**And** it MUST depend on `PppoeServiceRepository` (port) and `RadiusEventRepository` (port)
**And** MUST NOT import from `@infrastructure/*` or `@prisma/client`

### REQ-UC-2: Sorting default is `username ASC`

**Given** the audit shows the full padrón as a registry
**When** no explicit sort is provided
**Then** results MUST be ordered by `username ASC`

### REQ-UC-3: Last-connection enrichment is a single efficient query

**Given** the enrichment requires the latest `RadiusEvent` per username
**When** the use case queries the repository
**Then** the Prisma adapter SHOULD execute a single aggregated query (e.g. `groupBy username, max(startedAt)`) rather than N+1 queries per PPPoE service

#### Scenario: N+1 is forbidden

**Given** the NE8000 padrón has 500 PPPoE services
**When** `ListNe8000PppoeAudit` runs
**Then** it MUST NOT execute 500 individual `RadiusEvent` lookups
**And** it MUST use at most 2 DB queries: (1) paginated `PppoeService` list, (2) aggregated last-event per username for the fetched batch

---

## 7. Route

### REQ-ROUTE-1: Route registered at `GET /radius/ne8000/audit`

**Given** the existing `radius.routes.ts` (or `network-audit.routes.ts`)
**When** the route is registered
**Then** `GET /radius/ne8000/audit` MUST be accessible
**And** it MUST be gated by: `createAuthMiddleware` → `requirePermission('network.read')` → handler
**And** NO other HTTP methods (POST, PUT, DELETE, PATCH) MUST be registered on this path

---

## 8. DIP Compliance

### REQ-DIP-1: No Prisma in use case

**Given** `ListNe8000PppoeAudit` in `src/application/use-cases/`
**When** `tsc --noEmit` runs
**Then** it MUST NOT import from `@prisma/client` or `@infrastructure/*`

---

## Appendix: Query Param Summary

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `username` | `string` | — | ILIKE substring search |
| `status` | `enabled\|disabled` | — | `PppoeService.status` exact |
| `enforcedState` | `active\|reduced\|blocked` | — | `PppoeService.enforcedState` exact |
| `online` | `boolean` | — | Derived from RadiusEvent |
| `page` | `integer >= 1` | 1 | |
| `limit` | `integer 1–200` | 50 | Server cap at 200 |
