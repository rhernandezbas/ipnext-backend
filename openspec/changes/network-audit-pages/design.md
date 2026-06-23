# Design: network-audit-pages

## Overview

Two **read-only audit pages** in "Gestión de Red", backed by a shared event engine that mirrors RADIUS accounting (`radacct`) into a Prominense-owned table. Zero mutations — PPPoE management keeps its contract-driven flow untouched.

1. **Logs RADIUS** — temporal history of PPPoE connect/disconnect events, filterable (NOT the active-sessions page, which already exists as `RadiusSession` + `GET /radius/sessions`).
2. **Auditoría NE8000** — read-only padrón of the PPPoE that terminate on the Huawei NE8000 BRAS, with status + last connection, scoped by `nasId`.

The data lands via an **incremental ingest scheduler** that calls `orchestrator.listAccounting(cursor)`, upserting `RadiusEvent` rows keyed by `acctuniqueid` for idempotency. Prominense **never** reads `radacct` directly — the orchestrator (FastAPI VIP `http://10.75.0.20:8080`, bearer) is the only component allowed to touch the RADIUS DB. This is the architectural law of the project and it shapes every decision below.

This is an EPIC across 3 repos. Auth failures / failed logins (NE8000 `online-fail-record`) are explicitly **Phase 2** — they do not live in `radacct` and require a separate NE8000 integration.

## Architecture (3 repos)

```
┌──────────────────────┐     GET /accounting?cursor=…     ┌───────────────────────────┐     SELECT … FROM radacct     ┌──────────────┐
│  ipnext-backend      │  ─────────────────────────────►  │  freeradius-orchestrator  │  ──────────────────────────►  │  MariaDB     │
│  (Prominense, this)  │     bearer token (server-side)   │  (FastAPI, VIP :8080)     │     parses nasportid→vlan     │  RADIUS HA   │
│                      │  ◄─────────────────────────────  │                           │  ◄──────────────────────────  │  radacct     │
│  RadiusAccountingIngest    paginated curated JSON        │  ONLY reader of radacct   │                               │  10.75.0.10  │
│  scheduler → upsert  │                                  └───────────────────────────┘                               └──────────────┘
│  RadiusEvent (Postgres)
│                      │     GET /api/radius/events        ┌───────────────────────────┐
│  ListRadiusEvents    │  ◄─────────────────────────────  │  ipnext-frontend          │
│  ListNe8000PppoeAudit│     GET /api/radius/ne8000/audit  │  Logs RADIUS page         │
│  (network.read)      │  ─────────────────────────────►  │  Auditoría NE8000 page    │
└──────────────────────┘                                  └───────────────────────────┘
```

Dependency direction stays hexagonal: `infrastructure → application → domain`. The new port (`RadiusEventRepository`) and the new gateway method live in `domain/`; adapters (Prisma, in-memory, HTTP) live in `infrastructure/`; use cases depend on ports only. No use case imports Prisma, Express, or axios.

## Data model

### `RadiusEvent` (new table)

Mirror of one `radacct` row = one session. The orchestrator pre-parses the Huawei `nasportid` so the BE never sees raw RADIUS format. Octets are `BigInt` (a heavy user blows past 2³¹ bytes easily).

```prisma
model RadiusEvent {
  id             String    @id @default(uuid())
  /// = radacct.acctuniqueid — THE idempotency key. Upsert target.
  sourceUniqueId String    @unique
  username       String
  nasIpAddress   String                       // raw radacct.nasipaddress (always present)
  nasId          String?                       // resolved against NasServer on ingest; null until matched
  framedIp       String?                       // radacct.framedipaddress
  macAddress     String?                       // radacct.callingstationid (CPE MAC)
  vlanId         Int?                          // parsed by orchestrator from nasportid (vlanid==N)
  startedAt      DateTime                      // radacct.acctstarttime
  stoppedAt      DateTime?                     // radacct.acctstoptime — NULL ⇒ session still online
  sessionTime    Int?                          // radacct.acctsessiontime (seconds)
  inOctets       BigInt    @default(0)         // radacct.acctinputoctets
  outOctets      BigInt    @default(0)         // radacct.acctoutputoctets
  status         String                        // "online" (stoppedAt null) | "closed"
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt          // bumped when an open session later closes

  nas            NasServer? @relation(fields: [nasId], references: [id], onDelete: SetNull)

  @@index([username])
  @@index([nasId])
  @@index([vlanId])
  @@index([startedAt])
  @@index([stoppedAt])
  @@index([status])
  @@index([username, startedAt])              // composite for "última conexión por username"
}
```

`status` is **derived on ingest**, not stored by RADIUS: `online` when `stoppedAt` is null, `closed` otherwise. It is denormalized into a column (not computed on-read) so the Logs page can filter `online`/`offline` with a plain indexed `WHERE`. See AD-1.

`NasServer` gets the back-relation:

```prisma
model NasServer {
  // …existing fields…
  radiusEvents RadiusEvent[]
}
```

### `NasServer` seed — NE8000 BRAS

Registered via an **idempotent seed migration** (`ON CONFLICT DO NOTHING`, project pattern). The `nasIpAddress` MUST equal the BRAS's real value as it appears in `radacct.nasipaddress` — that string is the join key during ingest (`nasIpAddress → nasId`) and the scope key for the Auditoría page. **This exact value is Phase 0** (see Open Questions). `type` decision in AD-3.

```sql
-- idempotent: re-running the migration is a no-op. NO BEGIN/COMMIT in migration.sql.
INSERT INTO "NasServer" (id, name, type, "ipAddress", "nasIpAddress", status, description)
VALUES (
  'ne8000-bras-1',                 -- stable id so the seed + FE filter agree
  'NE8000 BRAS-1 (Huawei)',
  'huawei_radius',                 -- AD-3
  '<BRAS mgmt IP — Phase 0>',
  '<radacct.nasipaddress — Phase 0>',
  'active',
  'BRAS Huawei NE8000-1 — termina PPPoE Acceso Sur (RADIUS HA)'
)
ON CONFLICT (id) DO NOTHING;
```

### `RadiusEventIngestState` — the cursor

Reuse the existing `SyncState` table (`entity` PK + `cursor` String + `lastRunAt`/`lastResult`/`itemsSynced`), exactly like the GR/UISP schedulers. No new table. Entity key: `radius-accounting-ingest`. The `cursor` holds the high-watermark (see AD-2). This keeps the scheduler symmetric with the 7 existing ones and reuses `PrismaSyncStateRepository`.

## Ingestion flow

### Strategy (the cursor + the open-session problem)

The hard part: a session is inserted into `radacct` **open** (`acctstoptime = NULL`, online) and the **same row** is updated later when it closes (`acctstoptime` filled). A naive "give me everything after timestamp T" cursor would either miss the later close-update or reprocess forever.

Solution = **idempotent upsert + a re-scan window**:

- The cursor is a watermark on `acctstarttime` (the only column that is set once and never moves). We persist `lastStartedAt` (ISO) in `SyncState.cursor`.
- Each tick asks the orchestrator for rows with `acctstarttime >= (lastStartedAt − reScanWindow)`. The `reScanWindow` (default **2h**, configurable) deliberately re-fetches recently-started sessions so that sessions which were open last tick and have since closed get their `acctstoptime`/`status`/octets refreshed.
- Every row is **upserted by `sourceUniqueId`** (`acctuniqueid`, `@unique`). First sight ⇒ insert (status `online`). Later sight after close ⇒ update (`stoppedAt`, `sessionTime`, octets, `status='closed'`, `updatedAt` bumps). The `@unique` constraint makes re-runs safe and exactly-once in effect.
- After a successful page sweep, advance `lastStartedAt` to the max `acctstarttime` seen. The window subtraction guarantees we never strand a still-open session.
- `nasId` is resolved per row by matching `nasIpAddress` against registered `NasServer.nasIpAddress`. No match ⇒ `nasId = null` (the event is still recorded; matching is best-effort and the table self-heals on the next tick once the NAS is seeded). Resolution map is loaded once per run.

Trade-off accepted: a 2h overlap re-reads a bounded slice each tick. At a few-minute interval this is cheap and the upsert dedups it. AD-2 covers the alternative (cursor by `acctuniqueid`) and why it loses.

### Sequence diagram — accounting ingest

```
 Scheduler        DistributedLock     SyncStateRepo      Gateway              Orchestrator        radacct (MariaDB)    RadiusEventRepo
    │                   │                  │                │                      │                    │                   │
    │ tick (setInterval)│                  │                │                      │                    │                   │
    │ inFlight guard ───┤                  │                │                      │                    │                   │
    │ tryAcquire('radius-accounting-ingest')────────────────────────────────────────────────────────────────────────────►│
    │◄── acquired ──────┤                  │                │                      │                    │                   │
    │ get('radius-accounting-ingest') ────►│                │                      │                    │                   │
    │◄── cursor=lastStartedAt ─────────────┤                │                      │                    │                   │
    │ since = cursor − reScanWindow (2h)   │                │                      │                    │                   │
    │ listAccounting({ sinceStart: since, page:1 }) ───────►│                      │                    │                   │
    │                   │                  │                │ GET /accounting?…────►│                    │                   │
    │                   │                  │                │                      │ SELECT … WHERE      │                   │
    │                   │                  │                │                      │  acctstarttime>=…  ─►│                   │
    │                   │                  │                │                      │  ORDER BY acctstart │                   │
    │                   │                  │                │                      │◄── rows ────────────┤                   │
    │                   │                  │                │                      │ parse nasportid→vlan│                   │
    │                   │                  │                │◄── {items,nextPage}──┤ (BE never sees raw) │                   │
    │◄── page DTO ──────────────────────────────────────────┤                      │                    │                   │
    │ FOR each row: resolve nasId (nasIp→NasServer), derive status                  │                    │                   │
    │ upsert by sourceUniqueId (insert | update stoppedAt/octets/status) ──────────────────────────────────────────────►   │
    │◄── upserted ──────────────────────────────────────────────────────────────────────────────────────────────────────┤
    │ (loop next page until nextPage == null)                                       │                    │                   │
    │ save cursor = max(acctstarttime seen); lastResult='ok'; itemsSynced=N ───────►│                      │                   │
    │ PURGE: deleteOlderThan(now − retention) batched ──────────────────────────────────────────────────────────────────►  │
    │ release('radius-accounting-ingest') ──────────────────────────────────────────────────────────────────────────────► │
    │ inFlight = false  │                  │                │                      │                    │                   │
```

### Scheduler shape (mirrors the 7 existing schedulers, EXACT)

`RadiusAccountingIngestScheduler` under `src/infrastructure/scheduling/`:

- `setInterval` + `timer.unref()`; `runOnce()` on start.
- Synchronous `inFlight` guard set BEFORE any `await` (the UISP scheduler's FIX-4 — pg advisory locks are re-entrant in the same session, so the in-process flag is mandatory).
- `DistributedLock.tryAcquire('radius-accounting-ingest')` cross-replica guard; `release` in `finally`.
- Feature-flag gate `radius-accounting-ingest` via `FeatureFlagRepository` (dark by default, like UISP/GR).
- Interval + retention + re-scan window read from a single-row config table (mirrors `GestionRealIngestConfig`), so they're tunable without redeploy. Default interval **300_000ms (5 min)**.
- Errors swallowed + persisted to `SyncState.lastResult='error: <msg>'` so a bad cycle never kills the timer and the failure is observable.
- Composition root `bootstrapRadiusAccountingIngest(intervalMs)` returns `null` when `config.orchestrator.baseUrl` is absent (opt-in, same as UISP). Dark-by-default: no orchestrator config → ticks log "skipped — not configured", no network call.

## Orchestrator contract (BE ↔ freeradius-orchestrator)

Cross-repo contract is explicit, field by field (project lesson: the cross-repo contract is never implicit). The orchestrator owns the `radacct` SELECT, the `nasportid → vlan` parse, and pagination.

### `GET /accounting`

**Query params** (all optional except as noted):

| Param | Type | Meaning |
|-------|------|---------|
| `since_start` | ISO 8601 datetime | `WHERE acctstarttime >= since_start`. The ingest cursor uses this. |
| `until_start` | ISO 8601 datetime | upper bound (rarely used; for backfill windows) |
| `username` | string | exact `WHERE username = ?` (Logs page filter passthrough — but the page hits the BE, see below) |
| `nasipaddress` | string | exact NAS filter |
| `page` | int ≥ 1 | 1-based page (default 1) |
| `page_size` | int | rows per page (default 500, max 1000 — bulk ingest) |

Order is **`ORDER BY acctstarttime ASC, acctuniqueid ASC`** — deterministic and aligned with the watermark so paging never skips a row.

**Response JSON** (paginated, curated — the BE maps these snake_case keys in `HttpRadiusOrchestratorGateway`):

```json
{
  "items": [
    {
      "unique_id":        "a1b2c3d4e5f6...",        // acctuniqueid  → sourceUniqueId
      "username":         "cliente1234",
      "nasipaddress":     "10.75.0.30",             // → nasIpAddress
      "framedipaddress":  "100.64.12.7",            // → framedIp (nullable)
      "callingstationid": "AA:BB:CC:DD:EE:FF",      // → macAddress (nullable)
      "vlan":             3713,                      // parsed by orchestrator from nasportid (nullable)
      "acctstarttime":    "2026-06-22T13:04:11Z",   // → startedAt
      "acctstoptime":     null,                      // → stoppedAt (null ⇒ online)
      "acctsessiontime":  0,                          // → sessionTime (seconds, nullable)
      "acctinputoctets":  "1048576",                 // string (BigInt-safe) → inOctets
      "acctoutputoctets": "2097152"                  // string (BigInt-safe) → outOctets
    }
  ],
  "page": 1,
  "page_size": 500,
  "next_page": 2                                     // null when last page
}
```

Notes:
- Octets are JSON **strings** to survive `> 2^53` without precision loss; the gateway parses them to `BigInt`.
- `calledstationid` is **omitted** — verified empty in `radacct`. RADIUS does not know the fine AP, only the VLAN. The Auditoría page must not promise AP-level granularity.
- The orchestrator does the `vlanid==(\d+)` parse on `nasportid`. The BE never sees the Huawei `slot==0;subslot==5;…` string. If `nasportid` lacks a vlanid, `vlan` is `null`.
- Auth: `Authorization: Bearer <token>` (existing pattern). Errors map exactly like today: orchestrator 4xx → `OrchestratorRejectedError`; network/timeout/5xx → `OrchestratorUnreachableError` (route → 502, ingest → logged + `lastResult='error'`).

### Gateway port addition

```ts
// src/domain/ports/RadiusOrchestratorGateway.ts (new types + method)
export interface ListAccountingFilters {
  sinceStart?: string;     // ISO — the ingest cursor
  untilStart?: string;
  username?: string;
  nasIpAddress?: string;
  page?: number;           // 1-based
  pageSize?: number;
}
export interface AccountingEventRow {
  uniqueId: string;
  username: string;
  nasIpAddress: string;
  framedIp: string | null;
  macAddress: string | null;
  vlan: number | null;
  startedAt: string;       // ISO
  stoppedAt: string | null;
  sessionTime: number | null;
  inOctets: bigint;
  outOctets: bigint;
}
export interface AccountingPage {
  items: AccountingEventRow[];
  page: number;
  pageSize: number;
  nextPage: number | null;
}

// added to interface RadiusOrchestratorGateway:
listAccounting(filters: ListAccountingFilters): Promise<AccountingPage>;
```

`HttpRadiusOrchestratorGateway.listAccounting` calls `GET /accounting`, maps snake_case → camelCase (a `toAccountingRow(r)` helper next to `toSession`), parses octet strings to `bigint`. In-memory adapter (tests) returns a fixed page set.

## Query API + DTOs

New port + use cases depend on the port, never on Prisma. Routes return **curated DTOs**, never raw Prisma rows.

### Port + repository

```ts
// src/domain/ports/RadiusEventRepository.ts
export interface RadiusEventFilters {
  username?: string;
  nasId?: string;
  vlanId?: number;
  status?: 'online' | 'closed';
  from?: Date;             // startedAt >= from
  to?: Date;               // startedAt <= to
  page: number;
  pageSize: number;
}
export interface RadiusEventRepository {
  list(filters: RadiusEventFilters): Promise<PaginatedResult<RadiusEvent>>;
  upsertByUniqueId(rows: RadiusEventUpsert[]): Promise<number>;   // ingest path
  /** latest startedAt per username, scoped to a nasId — powers the Auditoría "última conexión". */
  lastEventByUsername(nasId: string, usernames: string[]): Promise<Map<string, RadiusEvent>>;
  deleteOlderThan(cutoff: Date, batchSize: number): Promise<number>; // purge
}
```

Adapters: `PrismaRadiusEventRepository` + `InMemoryRadiusEventRepository` (tests). Domain entity `RadiusEvent` (interface, in `src/domain/entities/radius-event.ts`) — distinct from the Prisma model; a mapper translates.

### Use cases

- **`ListRadiusEvents`** — filters (username, nasId, vlanId, status online/closed, date range) + pagination. Returns `PaginatedResult<RadiusEventDto>`. Powers Logs RADIUS.
- **`ListNe8000PppoeAudit`** — composes two ports: `PppoeServiceRepository` (filter by the NE8000 `nasId`) ⨯ `RadiusEventRepository.lastEventByUsername(nasId, usernames)`. Returns the padrón: `{ username, status, enforcedState, lastConnectionAt, lastStatus, vlanId?, macAddress? }`. The NE8000 `nasId` is resolved by looking up `NasServer` by the seeded stable id (`ne8000-bras-1`) — passed in via config/lookup, not hardcoded in the use case.

### DTOs (curated — no raw Prisma)

```ts
// src/application/dto/radius-event.dto.ts
export interface RadiusEventDto {
  id: string;
  username: string;
  nasId: string | null;
  nasName: string | null;        // joined display name; null if unmatched
  framedIp: string | null;
  macAddress: string | null;
  vlanId: number | null;
  startedAt: string;             // ISO
  stoppedAt: string | null;
  sessionTimeSeconds: number | null;
  inOctets: string;              // BigInt → string for JSON safety
  outOctets: string;
  status: 'online' | 'closed';
}
export interface Ne8000AuditRowDto {
  username: string;
  status: 'online' | 'offline';   // online if a current open RadiusEvent exists
  enforcedState: string;          // from PppoeService (active|reduced|blocked)
  lastConnectionAt: string | null;
  vlanId: number | null;
  macAddress: string | null;
}
```

### Routes

Add to `radius.routes.ts` (sibling endpoints, same guard pattern as `GET /sessions`):

| Method | Path | Guard | Use case |
|--------|------|-------|----------|
| `GET` | `/api/radius/events` | `network.read` | `ListRadiusEvents` (query: username, nasId, vlanId, status, from, to, page, pageSize) |
| `GET` | `/api/radius/ne8000/audit` | `network.read` | `ListNe8000PppoeAudit` (query: username, status, page, pageSize) |

No `network.manage`, no `DELETE`, no `POST` — read-only by design (AD-9). Query params validated with zod schemas in `src/infrastructure/http/schemas/` (boundary-only; use cases receive inferred types).

## Frontend pages (ipnext-frontend)

Two **separate** read-only pages under "Gestión de Red", each: URL-backed filters + `Pagination`, following `RecaptacionPage` / `TicketsListPage`. Built with the **`ui-ux-pro-max`** skill (mandatory).

- **Logs RADIUS** (`/admin/networking/radius-logs`): table of events; filters = cliente/username, NAS, VLAN, status (online/offline), date range. Columns: username, NAS, VLAN, IP, MAC, inicio, fin, duración, octets, estado. Flapping is visible as multiple short rows per username.
- **Auditoría NE8000** (`/admin/networking/ne8000-audit`): padrón scoped to the NE8000; columns = username, estado (online/offline), enforcedState, última conexión, VLAN, MAC. Filters = username, status.
- Two `Sidebar.tsx` items in "Gestión de red", each `requiredPermission: network.read` + `RequirePermission` route guards.

## Retention / purge

Default **12 months**, configurable (`retentionMonths` in the ingest config row). Implemented as a **batched DELETE step inside the same ingest scheduler** (runs after the upsert sweep, same lock held): `deleteOlderThan(now − retentionMonths, batchSize=10_000)` looping until no rows remain in the tick. Indexed on `startedAt` so the predicate is cheap. AD-6 covers why DELETE beats partitioning for v1.

## app.ts wiring (God Object flag)

⚠️ **FLAG — God Object**: `src/infrastructure/http/app.ts` is **617 lines** (`known_debt: god-object-app`, MEDIUM). This change MUST touch it. Keep the additions minimal and grouped under one banner comment; do NOT refactor app.ts here — flag it for a separate change.

Additions to `createApp(...)`:

1. Signature: add `radiusAccountingIngest?: RadiusAccountingIngestScheduler | null` param (last, optional — same shape as `uispSyncScheduler`), so `main.ts` can pass the bootstrapped instance.
2. Under a new `// === RADIUS accounting / network audit ===` block:
   - `const radiusEventRepo = new PrismaRadiusEventRepository();`
   - `const listRadiusEvents = new ListRadiusEvents(radiusEventRepo);`
   - `const listNe8000Audit = new ListNe8000PppoeAudit(pppoeServiceRepo, radiusEventRepo, nasRepo);`
   - the `orchestrator` singleton already exists (line ~1121) — **reuse it**, no new instance. The ingest scheduler is built in its own `bootstrap*` (composition root), NOT inline in app.ts.
3. Extend the existing `createRadiusRouter(...)` call (line ~1702) with the 2 new use cases, OR keep `radius.routes.ts` and pass them through — one-line change either way.

Additions to `main.ts`: `const radiusAccountingIngest = await bootstrapRadiusAccountingIngest(300_000);` then pass into `createApp(...)` and `.start()` it (mirrors `bootstrapUispSync`).

Net God Object delta: ~6–8 lines in app.ts + 2 lines in main.ts. Acceptable; flagged.

## Architecture decisions

| # | Decision | Chosen | Alternative rejected | Rationale |
|---|----------|--------|----------------------|-----------|
| **AD-1** | `status` (online/closed) | **Denormalized column**, derived on ingest | Compute on-read (`stoppedAt IS NULL`) | The Logs page filters online/offline constantly; an indexed `WHERE status=…` beats a computed predicate at scale, and it lets us index `[status]` directly. Cost: bump it on the close-update — already happening in the same upsert. |
| **AD-2** | Ingest cursor | **Watermark on `acctstarttime` + 2h re-scan window + upsert by `acctuniqueid`** | Cursor by max `acctuniqueid` (auto-inc); or "since last run" timestamp without overlap | `acctuniqueid` is a hash, not monotonic — useless as a `>` cursor. A no-overlap timestamp would miss the late close-update of sessions that were open last tick. The window+upsert is the only strategy that captures both new sessions AND deferred closes, idempotently. Bounded re-read is cheap at 5-min ticks. |
| **AD-3** | NE8000 NasType | **Add `'huawei_radius'` to `NasType`** | Reuse `'mikrotik_radius'` | The BE routes enforcement/IP-allocation by `nas.type` (app.ts line ~2063: `mikrotik_radius → orchestrator + CoA`). Reusing `mikrotik_radius` would make the audit-only NE8000 look like a Mikrotik that accepts MK-specific enforcement paths — a latent bug the day someone wires management. A distinct variant is honest and future-proof; the Huawei VSAs/enforcement already exist in the RADIUS, only the BE label is missing. Additive enum change, no migration risk. |
| **AD-4** | "Última conexión" (Auditoría) | **Computed on-read** via `lastEventByUsername(nasId, usernames)` (indexed `[username, startedAt]`) | Denormalize `lastConnectionAt` onto `PppoeService` | Denormalizing would couple the ingest scheduler to writes on `PppoeService` (a management-flow table) — crossing the read-only boundary of this EPIC. The composite index makes the on-read MAX cheap, and the Auditoría page is paged (bounded username set per page). Keep PppoeService untouched. |
| **AD-5** | Octets transport | **`BigInt` in DB + Prisma; strings over JSON** (orchestrator→BE and BE→FE) | `number` (float) | A heavy user exceeds `2^53` bytes; float loses precision silently. Strings are the standard JSON-safe BigInt carrier. |
| **AD-6** | Retention | **Batched DELETE inside the ingest scheduler**, `retentionMonths` configurable, default 12 | PostgreSQL range partition by month | Partitioning needs DDL automation (create/drop monthly partitions) and complicates migrations + the in-memory test adapter. A bounded indexed DELETE is the simpler, reversible v1. If volume proves the DELETE too heavy, partitioning is a clean follow-up change. |
| **AD-7** | Cursor storage | **Reuse `SyncState` table**, entity=`radius-accounting-ingest` | New `RadiusEventIngestState` table | The 7 existing schedulers all use `SyncState`; reusing it keeps the scheduler symmetric, reuses `PrismaSyncStateRepository`, and avoids a needless migration. |
| **AD-8** | `nasId` on unmatched events | **Nullable; best-effort resolve on ingest; self-heals** | Block ingest until NAS is seeded; or store only `nasIpAddress` | Recording the event with `nasId=null` loses nothing — the next tick's re-scan window re-resolves it once the NAS exists. Never drop accounting data over a missing FK. `onDelete: SetNull` keeps events if a NAS row is removed. |
| **AD-9** | Mutations | **None — `network.read` only, no DELETE/POST/PATCH** | Expose a manual "re-ingest now" trigger | The EPIC is observe-only. A trigger would add a mutation surface for no operational need (the scheduler already ticks every 5 min). If needed later, add it as a guarded `network.manage` POST in a separate change. |
| **AD-10** | Orchestrator instance | **Reuse the existing `orchestrator` singleton** in app.ts | New `HttpRadiusOrchestratorGateway` for ingest | It's already constructed (line ~1121) and shared by PPPoE enforcement + IP allocator. One client, one config, one timeout policy. |

## Testing strategy

| Layer | What | Approach |
|-------|------|----------|
| Unit | `ListRadiusEvents` filters + pagination | Strict TDD: RED against `InMemoryRadiusEventRepository` → GREEN |
| Unit | `ListNe8000PppoeAudit` composes PppoeService ⨯ last-event map | In-memory both ports; assert online/offline + lastConnectionAt |
| Unit | Ingest mapper: `AccountingEventRow → RadiusEventUpsert` (status derive, octet BigInt, nasId resolve, vlan null) | Pure-function tests incl. open-then-close upsert |
| Unit | Scheduler: inFlight guard, lock-held skip, flag-OFF skip, error → SyncState | Fake `DistributedLock` + in-memory repos, like UISP scheduler tests |
| Unit | `HttpRadiusOrchestratorGateway.listAccounting` snake→camel + octet string→bigint + 4xx/5xx error mapping | Injected fake AxiosInstance |
| Integration | `GET /api/radius/events` + `/api/radius/ne8000/audit` shape + `network.read` guard (401/403) | supertest + in-memory repos injected |
| Non-regression | full suite | green at each commit |
| Static | `tsc --noEmit` 0 errors; `rg "from '@infrastructure" src/application/use-cases/` → 0 new | hexagonal invariant |

## Migration / rollout

- **Migration** (additive, pushes direct): `add_radius_event_model` — `RadiusEvent` table + indexes + `NasServer.radiusEvents` back-relation. No `BEGIN/COMMIT` in `migration.sql`.
- **NasType**: `'huawei_radius'` is a TS union literal (`nas.ts`), not a Prisma enum (`NasServer.type` is `String`) — no DB enum migration, just the type widening + seed.
- **Seed migration**: NE8000 `NasServer` row, idempotent `ON CONFLICT (id) DO NOTHING`. **Blocked on Phase 0** (real `nasIpAddress`).
- **Config row**: `RadiusAccountingIngestConfig` (singleton) — interval, retentionMonths, reScanWindowMinutes — seeded with defaults.
- **Feature flag** `radius-accounting-ingest`: dark by default. Flip ON to start ingesting.
- **Rollback**: drop `RadiusEvent` + the seed row; remove scheduler wiring from app.ts/main.ts; remove the 2 routes; remove the 2 FE pages. Orchestrator `GET /accounting` can stay inert. Zero operational data loss (Prominense never wrote to RADIUS).

## Open questions (Phase 0)

- [ ] **NE8000 `nasipaddress` in `radacct`** — the exact value the BRAS sends as `nasipaddress`. This is the join key (`nasIpAddress → nasId`) AND the seed identity AND the Auditoría scope. Without it the seed and the audit page are guesswork. **Hard blocker for the seed + ne8000-audit.**
- [ ] **Confirm `GET /accounting` contract with the orchestrator owner** — query params, pagination semantics (`page`/`next_page` vs keyset), octets-as-strings, and that the orchestrator (not the BE) does the `nasportid → vlan` parse. The gateway + cursor depend on this exactly.
- [ ] **Re-scan window value** — is 2h enough to catch all deferred closes? Depends on the max realistic open-session duration before `acctstoptime` lands. If sessions stay open for days, the window must cover the longest expected open session OR we add a "refresh still-open events" pass. **Confirm with RADIUS HA behavior.**
- [ ] **Multiple BRAS / RADIUS HA pair** — does `radacct` carry sessions from both HA nodes under one `nasipaddress`, or per-node? Affects whether one seed row suffices.
- [ ] **`vlanId → node` mapping** — VLAN is recorded but the VLAN→physical-node map is lossy and out of scope here; confirm the Auditoría page does NOT need node-level grouping in v1.
- [ ] **Volume estimate** — rows/day in `radacct` to validate AD-6 (DELETE vs partition) and the page_size/interval defaults.

## Out of scope — Phase 2

Auth failures / failed logins (NE8000 `online-fail-record`) — not in `radacct`, requires a separate NE8000 integration. Named, not built.
