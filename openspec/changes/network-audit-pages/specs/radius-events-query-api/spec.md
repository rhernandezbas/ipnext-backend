# Spec: radius-events-query-api

**Capability**: `radius-events-query-api`
**Type**: New (read-only use case + HTTP route)
**Change**: `network-audit-pages`
**Use case**: `src/application/use-cases/ListRadiusEvents.ts`
**DTO**: `src/application/dto/radius-event.dto.ts`
**Route**: `GET /radius/events` in `src/infrastructure/http/routes/radius.routes.ts` (or `network-audit.routes.ts`)
**Permission**: `network.read`

> READ-ONLY by design. No POST/PUT/DELETE scenarios exist in this spec.
> The Logs RADIUS frontend page consumes this endpoint.

---

## 1. Authentication and Authorization

### REQ-AUTH-1: Unauthenticated request is rejected

**Given** a request to `GET /radius/events` without an `auth_token` cookie
**When** the request is received
**Then** the server MUST respond with HTTP 401
**And** the body MUST contain `{ "code": "UNAUTHORIZED" }`

### REQ-AUTH-2: Invalid or expired token is rejected

**Given** a request to `GET /radius/events` with an invalid `auth_token` cookie
**When** `JwtAuthAdapter.getSession` fails to verify the token
**Then** the server MUST respond with HTTP 401

### REQ-RBAC-1: Missing `network.read` permission is rejected

**Given** an authenticated request from a user without the `network.read` permission
**When** the request reaches the authorization middleware
**Then** the server MUST respond with HTTP 403
**And** the body MUST contain `{ "code": "FORBIDDEN" }`

#### Scenario: technician without network.read is rejected

**Given** a technician user authenticated via `auth_token`
**And** the user's effective permissions do NOT include `network.read`
**When** they request `GET /radius/events`
**Then** the server MUST respond with HTTP 403

#### Scenario: admin with network.read succeeds

**Given** an admin user with `network.read` in their effective permissions
**When** they request `GET /radius/events`
**Then** the server MUST respond with HTTP 200

---

## 2. Query Parameters and Filtering

### REQ-FILTER-1: All filters are optional

**Given** an authenticated, authorized request to `GET /radius/events` with no query parameters
**When** the server processes the request
**Then** it MUST return the most recent events (first page, default limit) with HTTP 200

### REQ-FILTER-2: `username` filter

**Given** a request to `GET /radius/events?username=c001`
**When** the use case queries `RadiusEventRepository`
**Then** it MUST return only events where `username = 'c001'`
**And** partial matches MUST be supported (ILIKE `%c001%`) to allow substring search

### REQ-FILTER-3: `nasId` filter scopes by NAS server

**Given** a request to `GET /radius/events?nasId=<uuid>`
**When** the use case queries the repository
**Then** it MUST return only events where `nasId = <uuid>`

### REQ-FILTER-4: `vlanId` filter

**Given** a request to `GET /radius/events?vlanId=3713`
**When** the use case queries the repository
**Then** it MUST return only events where `vlanId = 3713`

### REQ-FILTER-5: `from` and `to` date range

**Given** a request to `GET /radius/events?from=2026-06-01T00:00:00Z&to=2026-06-22T23:59:59Z`
**When** the use case queries the repository
**Then** it MUST return only events where `startedAt >= from AND startedAt <= to`
**And** both values MUST be accepted as ISO 8601 UTC strings

### REQ-FILTER-6: `eventType` filter

**Given** a request to `GET /radius/events?eventType=stop`
**When** the use case queries the repository
**Then** it MUST return only events where `eventType = 'stop'`
**And** accepted values are `start | stop | interim` — any other value MUST return HTTP 400

### REQ-FILTER-7: `online` boolean filter (shortcut for eventType)

**Given** a request to `GET /radius/events?online=true`
**When** the use case processes the filter
**Then** it MUST return only events where `stoppedAt IS NULL` (active sessions)

**Given** a request to `GET /radius/events?online=false`
**When** the use case processes the filter
**Then** it MUST return only events where `stoppedAt IS NOT NULL` (closed sessions)

### REQ-FILTER-8: Invalid filter value returns 400

**Given** a request to `GET /radius/events?eventType=unknown`
**When** the route validates query params
**Then** the server MUST respond with HTTP 400
**And** the body MUST contain `{ "code": "VALIDATION_ERROR" }`

---

## 3. Pagination

### REQ-PAGE-1: `page` and `limit` query params

**Given** a request to `GET /radius/events?page=2&limit=25`
**When** the use case queries the repository
**Then** it MUST skip the first 25 events and return the next 25
**And** `page` MUST default to 1 if omitted
**And** `limit` MUST default to 50 if omitted
**And** `limit` MUST be capped at 200 (server-side)

### REQ-PAGE-2: Pagination metadata in response

**Given** a successful `GET /radius/events` request
**When** the server responds with HTTP 200
**Then** the body MUST include:

| Field | Type | Description |
|-------|------|-------------|
| `data` | `RadiusEventDTO[]` | Events for the current page |
| `total` | `number` | Total matching events |
| `page` | `number` | Current page (1-based) |
| `limit` | `number` | Effective limit used |
| `hasNext` | `boolean` | Whether more pages exist |

### REQ-PAGE-3: Empty result is valid

**Given** no `RadiusEvent` rows match the applied filters
**When** the server responds
**Then** it MUST return HTTP 200 with `{ data: [], total: 0, page: 1, limit: 50, hasNext: false }`
**And** MUST NOT return 404

---

## 4. Response DTO

### REQ-DTO-1: `RadiusEventDTO` shape — no raw Prisma rows exposed

**Given** the hexagonal convention (no raw Prisma entities from routes)
**When** `ListRadiusEvents` returns results
**Then** each item MUST be mapped to a `RadiusEventDTO` before reaching the HTTP layer

`RadiusEventDTO` MUST contain:

| Field | Type | Notes |
|-------|------|-------|
| `id` | `string` | Row ID |
| `username` | `string` | PPPoE username |
| `nasIp` | `string` | NAS IP address |
| `nasName` | `string \| null` | Resolved from `NasServer.name` |
| `framedIp` | `string \| null` | Assigned IP |
| `macAddress` | `string \| null` | CPE MAC |
| `vlanId` | `number \| null` | Parsed VLAN |
| `startedAt` | `string` | ISO 8601 |
| `stoppedAt` | `string \| null` | ISO 8601, null if active |
| `sessionTime` | `number \| null` | Seconds |
| `bytesIn` | `string` | Octets as string (BigInt → string to avoid JSON precision loss) |
| `bytesOut` | `string` | Octets as string |
| `eventType` | `'start' \| 'stop' \| 'interim'` | Derived field |
| `online` | `boolean` | `stoppedAt === null` |

**And** `bytesIn`/`bytesOut` MUST be serialized as strings (BigInt is not JSON-serializable natively)
**And** `nasName` MUST be resolved by joining with `NasServer` — not a second round trip

### REQ-DTO-2: DTO MUST NOT expose `sourceUniqueId` or internal cursor fields

**Given** `sourceUniqueId` is an internal idempotency key
**When** the DTO is mapped
**Then** `sourceUniqueId` MUST NOT appear in the API response

---

## 5. Use Case

### REQ-UC-1: `ListRadiusEvents` lives in application layer

**Given** the DIP convention
**When** `ListRadiusEvents` is implemented
**Then** it MUST live in `src/application/use-cases/ListRadiusEvents.ts`
**And** it MUST depend on `RadiusEventRepository` (port), NEVER on Prisma directly
**And** it MUST return `{ data: RadiusEventDTO[]; total: number; page: number; limit: number; hasNext: boolean }`

### REQ-UC-2: Sorting default is `startedAt DESC`

**Given** `ListRadiusEvents` is called without an explicit sort
**When** the use case queries the repository
**Then** results MUST be ordered by `startedAt DESC` (most recent first)

---

## 6. Route

### REQ-ROUTE-1: Route registered under `/radius/events`

**Given** the existing `radius.routes.ts` (or a sibling `network-audit.routes.ts`)
**When** the route is registered
**Then** `GET /radius/events` MUST be accessible
**And** it MUST be gated by: `createAuthMiddleware` → `requirePermission('network.read')` → handler
**And** NO other HTTP methods (POST, PUT, DELETE, PATCH) MUST be registered on this path

### REQ-ROUTE-2: Route guards mirror `GET /radius/sessions`

**Given** the existing `GET /radius/sessions` as the reference (permission: `network.read`)
**When** `GET /radius/events` is implemented
**Then** it MUST use the same auth + RBAC middleware chain as `GET /radius/sessions`

---

## 7. DIP Compliance

### REQ-DIP-1: No Prisma in use case

**Given** `ListRadiusEvents` in `src/application/use-cases/`
**When** `tsc --noEmit` runs
**Then** it MUST NOT import `@prisma/client` or anything from `@infrastructure/*`

### REQ-DIP-2: `RadiusEventRepository` port required

**Given** the use case needs DB access
**When** it is implemented
**Then** a port interface `RadiusEventRepository` MUST be defined in `src/domain/ports/RadiusEventRepository.ts`
**And** the use case MUST depend on that port, not on any concrete adapter

---

## Appendix: Query Param Summary

| Param | Type | Default | Validation |
|-------|------|---------|------------|
| `username` | `string` | — | Substring search (ILIKE) |
| `nasId` | `UUID string` | — | Exact match |
| `vlanId` | `integer` | — | Exact match |
| `from` | `ISO 8601` | — | Must parse as valid date |
| `to` | `ISO 8601` | — | Must parse as valid date, >= from |
| `eventType` | `start\|stop\|interim` | — | Enum, 400 on invalid |
| `online` | `boolean` | — | `true` → active sessions only |
| `page` | `integer >= 1` | 1 | |
| `limit` | `integer 1–200` | 50 | Server cap at 200 |
