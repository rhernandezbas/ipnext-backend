# Spec: orchestrator-accounting-endpoint

**Capability**: `orchestrator-accounting-endpoint`
**Type**: New (cross-repo contract — lives in `freeradius-orchestrator`, consumed by `ipnext-backend`)
**Change**: `network-audit-pages`
**Route**: `GET /accounting`
**Repo**: `freeradius-orchestrator` (FastAPI, VIP `http://10.75.0.20:8080`)

> This spec describes the contract that `ipnext-backend` CONSUMES. The orchestrator owner implements it;
> Prominense adapts to it. Delta specs for the orchestrator side live in that repo — this file freezes
> the expected contract so the gateway adapter and ingest scheduler can be specced independently.

---

## 1. Authentication

### REQ-AUTH-1: Bearer token is required

**Given** a request to `GET /accounting` without an `Authorization: Bearer <token>` header
**When** the orchestrator receives the request
**Then** it MUST respond with HTTP 401
**And** the body MUST contain an error indicator (shape is orchestrator-defined)

### REQ-AUTH-2: Valid bearer token is accepted

**Given** a request to `GET /accounting` with a valid `Authorization: Bearer <token>` header
**When** the orchestrator verifies the token
**Then** it MUST process the request and return accounting data

---

## 2. Query Parameters

### REQ-PARAMS-1: All filters are optional

**Given** a request to `GET /accounting` with no query parameters and a valid bearer token
**When** the orchestrator processes the request
**Then** it MUST return the most recent accounting events (up to `limit`) with HTTP 200

### REQ-PARAMS-2: `username` filter narrows results

**Given** a request to `GET /accounting?username=user123`
**When** the orchestrator processes the request
**Then** it MUST return only events where `radacct.username = 'user123'`
**And** events for other usernames MUST NOT appear in the response

### REQ-PARAMS-3: `nasIp` filter narrows by NAS IP

**Given** a request to `GET /accounting?nasIp=10.75.0.5`
**When** the orchestrator processes the request
**Then** it MUST return only events where `radacct.nasipaddress = '10.75.0.5'`

### REQ-PARAMS-4: `vlan` filter narrows by parsed VLAN ID

**Given** a request to `GET /accounting?vlan=3713`
**When** the orchestrator processes the request
**Then** it MUST return only events whose `nasportid` contains `vlanid==3713`
**And** the VLAN parsing (regex `vlanid==(\d+)` on `nasportid`) MUST be done server-side
**And** `ipnext-backend` MUST NOT receive raw `nasportid` — only the parsed integer VLAN

### REQ-PARAMS-5: `from` and `to` filter by session start time

**Given** a request to `GET /accounting?from=2026-06-01T00:00:00Z&to=2026-06-22T23:59:59Z`
**When** the orchestrator processes the request
**Then** it MUST return only events where `acctstarttime >= from AND acctstarttime <= to`
**And** both `from` and `to` MUST be accepted as ISO 8601 UTC strings

### REQ-PARAMS-6: `status` filter accepts `active` and `closed`

**Given** a request to `GET /accounting?status=active`
**When** the orchestrator processes the request
**Then** it MUST return only sessions where `acctstoptime IS NULL` (still connected)

**Given** a request to `GET /accounting?status=closed`
**When** the orchestrator processes the request
**Then** it MUST return only sessions where `acctstoptime IS NOT NULL` (disconnected)

### REQ-PARAMS-7: `page` and `limit` control pagination

**Given** a request to `GET /accounting?page=2&limit=50`
**When** the orchestrator processes the request
**Then** it MUST return the second page of results with at most 50 events
**And** `limit` MUST default to 100 if omitted
**And** `page` MUST default to 1 if omitted

### REQ-PARAMS-8: `limit` has a server-side cap

**Given** a request to `GET /accounting?limit=10000`
**When** the orchestrator processes the request
**Then** it MUST cap the effective limit at a server-defined maximum (SHOULD NOT exceed 1000)
**And** the response MUST indicate the effective limit used

---

## 3. Response Shape

### REQ-RESP-1: Paginated envelope

**Given** an authenticated `GET /accounting` request
**When** the orchestrator responds with HTTP 200
**Then** the body MUST be a JSON object with:

| Field | Type | Description |
|-------|------|-------------|
| `data` | `AccountingEvent[]` | Array of accounting events for this page |
| `total` | `number` | Total matching rows (for pagination UI) |
| `page` | `number` | Current page number |
| `limit` | `number` | Effective limit used |
| `hasNext` | `boolean` | Whether more pages exist |

### REQ-RESP-2: `AccountingEvent` shape

**Given** an authenticated `GET /accounting` request returning events
**When** the response is inspected
**Then** each item in `data` MUST conform to:

| Field | Type | Nullable | Source in `radacct` |
|-------|------|----------|---------------------|
| `uniqueId` | `string` | No | `acctuniqueid` — stable cursor key |
| `username` | `string` | No | `username` |
| `nasIp` | `string` | No | `nasipaddress` |
| `framedIp` | `string \| null` | Yes | `framedipaddress` |
| `macAddress` | `string \| null` | Yes | `callingstationid` (empty → `null`) |
| `startedAt` | `string` | No | `acctstarttime` (ISO 8601 UTC) |
| `stoppedAt` | `string \| null` | Yes | `acctstoptime` (ISO 8601 UTC, `null` if session active) |
| `sessionTime` | `number \| null` | Yes | `acctsessiontime` (seconds) |
| `bytesIn` | `number` | No | `acctinputoctets` |
| `bytesOut` | `number` | No | `acctoutputoctets` |
| `vlanId` | `number \| null` | Yes | Parsed from `nasportid` via `vlanid==(\d+)` |
| `status` | `'active' \| 'closed'` | No | Derived: `null` stop → `active`, else `closed` |

### REQ-RESP-3: `calledstationid` is NOT in the response

**Given** the live `radacct` observation (verified 2026-06-22) that `calledstationid` is empty
**When** designing the response shape
**Then** the orchestrator MUST NOT include `calledstationid` in `AccountingEvent`
**And** `ipnext-backend` MUST NOT depend on it

### REQ-RESP-4: VLAN parsed by orchestrator, never by backend

**Given** a Huawei NE8000 `nasportid` value like `...vlanid==3713;...`
**When** the orchestrator builds the response
**Then** `vlanId` in the response MUST be the integer `3713` (already parsed)
**And** `ipnext-backend` MUST NOT receive raw `nasportid` strings

---

## 4. Error Contract

### REQ-ERR-1: 400 on invalid filter values

**Given** a request with an unparseable `from` date or `limit` below 1
**When** the orchestrator processes the request
**Then** it MUST respond with HTTP 400
**And** `ipnext-backend` MUST treat any 4xx response as `OrchestratorRejectedError`

### REQ-ERR-2: 5xx and network timeout map to unreachable

**Given** the orchestrator is down or returns HTTP 5xx
**When** `ipnext-backend` calls `GET /accounting`
**Then** the gateway adapter MUST throw `OrchestratorUnreachableError`
**And** the calling use case MUST NOT receive raw HTTP errors

---

## Appendix: Filter Summary

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `username` | `string` | — | Exact match on `radacct.username` |
| `nasIp` | `string` | — | Exact match on `radacct.nasipaddress` |
| `vlan` | `integer` | — | Parsed VLAN ID (orchestrator-side parsing) |
| `from` | `ISO 8601` | — | `acctstarttime >= from` |
| `to` | `ISO 8601` | — | `acctstarttime <= to` |
| `status` | `active \| closed` | — | `null` stoptime → active |
| `page` | `integer` | 1 | 1-based |
| `limit` | `integer` | 100 | Server cap applies |
