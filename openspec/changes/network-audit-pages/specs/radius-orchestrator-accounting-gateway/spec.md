# Spec: radius-orchestrator-accounting-gateway

**Capability**: `radius-orchestrator-accounting-gateway`
**Type**: Additive (new method on existing port + new adapter impl)
**Change**: `network-audit-pages`
**Port**: `src/domain/ports/RadiusOrchestratorGateway.ts`
**Adapter**: `src/infrastructure/adapters/orchestrator/HttpRadiusOrchestratorGateway.ts`
**In-memory**: `src/infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway.ts`

---

## 1. Port Contract

### REQ-PORT-1: `listAccounting` method added to `RadiusOrchestratorGateway`

**Given** the existing `RadiusOrchestratorGateway` interface in `src/domain/ports/RadiusOrchestratorGateway.ts`
**When** this capability is implemented
**Then** the interface MUST gain a new method:

```ts
listAccounting(filters: AccountingFilters): Promise<AccountingPage>;
```

**And** `AccountingFilters` and `AccountingPage` MUST be defined in the same port file
**And** neither type MUST import from `@infrastructure/*`

### REQ-PORT-2: `AccountingFilters` shape

**Given** the orchestrator query params defined in `orchestrator-accounting-endpoint`
**When** `AccountingFilters` is declared
**Then** all fields MUST be optional and typed as:

| Field | Type | Maps to orchestrator param |
|-------|------|----------------------------|
| `username` | `string` | `username` |
| `nasIp` | `string` | `nasIp` |
| `vlan` | `number` | `vlan` |
| `from` | `string` (ISO 8601) | `from` |
| `to` | `string` (ISO 8601) | `to` |
| `status` | `'active' \| 'closed'` | `status` |
| `page` | `number` | `page` |
| `limit` | `number` | `limit` |

### REQ-PORT-3: `AccountingEvent` domain type

**Given** the `AccountingEvent` shape from `orchestrator-accounting-endpoint`
**When** `AccountingEvent` is declared in the port file
**Then** it MUST have fields:

| Field | Type |
|-------|------|
| `uniqueId` | `string` |
| `username` | `string` |
| `nasIp` | `string` |
| `framedIp` | `string \| null` |
| `macAddress` | `string \| null` |
| `startedAt` | `string` |
| `stoppedAt` | `string \| null` |
| `sessionTime` | `number \| null` |
| `bytesIn` | `number` |
| `bytesOut` | `number` |
| `vlanId` | `number \| null` |
| `status` | `'active' \| 'closed'` |

**And** the type MUST NOT reference any Prisma or Express types

### REQ-PORT-4: `AccountingPage` shape

**Given** the paginated envelope from `orchestrator-accounting-endpoint`
**When** `AccountingPage` is declared
**Then** it MUST have:

| Field | Type |
|-------|------|
| `data` | `AccountingEvent[]` |
| `total` | `number` |
| `page` | `number` |
| `limit` | `number` |
| `hasNext` | `boolean` |

---

## 2. HTTP Adapter Implementation

### REQ-HTTP-1: Filter params are serialized as query string

**Given** a call to `listAccounting({ username: 'user1', vlan: 3713, limit: 50 })`
**When** `HttpRadiusOrchestratorGateway` builds the HTTP request
**Then** it MUST call `GET http://10.75.0.20:8080/accounting?username=user1&vlan=3713&limit=50`
**And** undefined/null fields MUST be omitted from the query string (no `username=undefined`)

#### Scenario: undefined filters omitted

**Given** `filters = { from: '2026-06-01T00:00:00Z' }` (all others undefined)
**When** the adapter serializes the request
**Then** the query string MUST be `?from=2026-06-01T00:00:00Z` only

### REQ-HTTP-2: Bearer token is included in every request

**Given** the orchestrator requires `Authorization: Bearer <token>`
**When** `HttpRadiusOrchestratorGateway.listAccounting` is called
**Then** the HTTP request MUST include `Authorization: Bearer ${RADIUS_ORCHESTRATOR_TOKEN}`
**And** the token MUST come from the injected config, NEVER hardcoded

### REQ-HTTP-3: Successful 200 response is mapped to `AccountingPage`

**Given** the orchestrator returns HTTP 200 with a valid paginated body
**When** the adapter processes the response
**Then** it MUST return an `AccountingPage` with all fields correctly mapped
**And** the raw orchestrator response shape MUST be mapped to domain types before returning
**And** `bytesIn`/`bytesOut` returned as strings by the orchestrator MUST be coerced to `number`

#### Scenario: full mapping

**Given** orchestrator returns `{ data: [{ uniqueId: 'u1', username: 'c001', nasIp: '10.75.0.5', framedIp: '100.64.1.2', macAddress: 'AA:BB:CC:DD:EE:FF', startedAt: '2026-06-22T10:00:00Z', stoppedAt: null, sessionTime: null, bytesIn: 1024, bytesOut: 2048, vlanId: 3713, status: 'active' }], total: 1, page: 1, limit: 100, hasNext: false }`
**When** the adapter maps the response
**Then** the returned `AccountingPage.data[0]` MUST equal the domain `AccountingEvent` with all fields populated

### REQ-HTTP-4: 4xx orchestrator responses throw `OrchestratorRejectedError`

**Given** the orchestrator returns HTTP 400 or 422
**When** `HttpRadiusOrchestratorGateway.listAccounting` receives the response
**Then** it MUST throw `OrchestratorRejectedError` (or equivalent domain error)
**And** MUST NOT throw a raw Axios/fetch error

### REQ-HTTP-5: 5xx and network errors throw `OrchestratorUnreachableError`

**Given** the orchestrator returns HTTP 500, 502, 503, or the TCP connection times out
**When** `HttpRadiusOrchestratorGateway.listAccounting` processes the failure
**Then** it MUST throw `OrchestratorUnreachableError`
**And** the error MUST be caught before propagating to the use case

---

## 3. In-Memory Adapter

### REQ-MEM-1: `InMemoryRadiusOrchestratorGateway` implements `listAccounting`

**Given** the in-memory adapter used in unit tests
**When** `listAccounting(filters)` is called
**Then** it MUST return a hardcoded or seeded `AccountingPage` consistent with the port contract
**And** it MUST apply `username` and `status` filters from `AccountingFilters` if pre-seeded data is present
**And** it MUST NOT make any HTTP calls

### REQ-MEM-2: In-memory adapter supports seeding events

**Given** tests need to verify ingest behavior
**When** the in-memory adapter is constructed
**Then** it SHOULD accept an optional initial `AccountingEvent[]` list
**And** `listAccounting` MUST return paginated slices of that list respecting `page` and `limit`

---

## 4. DIP Compliance

### REQ-DIP-1: No `@infrastructure/*` imports in port types

**Given** `AccountingFilters`, `AccountingEvent`, and `AccountingPage` are declared in `domain/ports/`
**When** `tsc --noEmit` runs
**Then** those types MUST NOT transitively import from `@infrastructure/*`

### REQ-DIP-2: Use cases receive the port interface, never the concrete adapter

**Given** `ListRadiusEvents` and `RadiusAccountingIngest` are use-case-layer components
**When** they call `listAccounting`
**Then** they MUST depend on `RadiusOrchestratorGateway` (the port interface)
**And** MUST NOT import `HttpRadiusOrchestratorGateway` directly

---

## Appendix: Error Types

| Condition | Error thrown |
|-----------|-------------|
| HTTP 4xx from orchestrator | `OrchestratorRejectedError` |
| HTTP 5xx / timeout / network failure | `OrchestratorUnreachableError` |
