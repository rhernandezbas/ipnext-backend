<!-- generated from engram topic_key: sdd/network-audit-pages/proposal -->
## Intent
Add two **read-only audit pages** to the "Gestión de Red" section across the 3-repo stack (frontend + backend + freeradius-orchestrator), backed by a shared event engine. Goal: let operators **observe** PPPoE network behavior without touching the operation. Zero mutations — PPPoE management stays on the contract-driven flow it has today.
1. **Logs RADIUS** — temporal history/log of PPPoE connect/disconnect events (NOT the active-sessions page, which already exists). Filterable.
2. **Auditoría NE8000** — read-only padrón of the PPPoE that terminate on the Huawei NE8000 BRAS, with status and last connection. Filterable.

This is an **EPIC**: deliver complete across all 3 repos. Out of scope (explicit Phase 2): auth failures / failed logins (NE8000 `online-fail-record`) — see "Out of scope" below.

## Why
- The active-sessions page (`GET /radius/sessions`, FE `/admin/networking/radius-sessions`) shows the live snapshot only. It cannot answer "how many times did this client flap today?" or "when did they last disconnect?". The data exists in `radacct` but is never persisted on the Prominense side.
- Verified live 2026-06-22: MariaDB `radacct` (RADIUS HA r1 `10.75.0.10`) holds one row per session with `acctstarttime`/`acctstoptime`, octets, `callingstationid` (MAC), and `nasportid` carrying the VLAN in Huawei format (`...vlanid==3713;`). A real client showed 4 short sessions in one day — exactly the flapping the Logs page is meant to surface. `calledstationid` is **empty** → RADIUS does not know the fine AP/wireless node, only the VLAN.
- The NE8000 BRAS is **invisible to the codebase today** (0 references to ne8000/huawei/bras; `NasType` in `src/domain/entities/nas.ts:1` has no Huawei variant). PPPoE terminating on the BRAS has no read model. The Auditoría page needs the NE8000 registered as a `NasServer` to scope its padrón.
- **Architectural law**: Prominense never talks to the RADIUS DB directly. It talks to the **orchestrator** (FastAPI, VIP `http://10.75.0.20:8080`, bearer token) over REST. The orchestrator is the only component allowed to read `radacct`. Today the gateway (`src/domain/ports/RadiusOrchestratorGateway.ts`) exposes no accounting/history method — it must be added on both sides.

## Proposed change — option A (recommended)
Additive, read-only, no impact on existing mutation flows. Three coordinated deliverables:

### 1. freeradius-orchestrator (repo: freeradius-orchestrator)
- New endpoint `GET /accounting` — paginated + filterable read over `radacct`. Filters: `username`, `nasipaddress`, `vlan` (parsed from `nasportid` via `vlanid==(\d+)`), event type (start/stop/active), date range, `online`/`offline`. Returns curated rows: username, nasipaddress, framedipaddress, acctstarttime, acctstoptime, acctsessiontime, in/out octets, callingstationid (MAC), parsed vlan, and a stable cursor key (`uniqueid` or `acctstoptime`+`acctuniqueid`). The orchestrator parses the Huawei `nasportid` so the BE never sees raw RADIUS format.

### 2. ipnext-backend (this repo)
- **Prisma migration**: new table `RadiusEvent` (mirror of accounting events): username, nasIpAddress, nasServerId (FK `NasServer`, nullable until matched), framedIp, vlan (nullable, raw/imprecise — VLAN→node mapping is lossy, do NOT block the EPIC on it), macAddress, startedAt, stoppedAt, sessionTime, inOctets, outOctets, eventType, sourceUniqueId @unique (idempotency cursor), createdAt. Indexes on (username), (nasIpAddress), (startedAt), (stoppedAt).
- **Gateway method** `listAccounting(filters)` added to the port `RadiusOrchestratorGateway` + impl in `HttpRadiusOrchestratorGateway` (calls `GET /accounting`). In-memory adapter for tests.
- **Ingest scheduler** `RadiusAccountingIngest` under `src/infrastructure/scheduling/` — reuse the established pattern (setInterval + `inFlight` guard + `DistributedLock` Postgres advisory + DB-configured interval), like the 7 existing schedulers (GestionRealSync/Ingest, IClassClosure, TaskAutocomplete, UispSync, Backfill). Incremental: cursor by `sourceUniqueId` / `acctstoptime`; upsert by `sourceUniqueId` (idempotent re-runs). On ingest, resolve `nasServerId` by matching `nasIpAddress` against registered `NasServer`s.
- **Retention (6–12 months)**: a purge step inside the ingest scheduler (delete `RadiusEvent` older than configurable window, default 12 months). Design doc to decide purge-job vs PostgreSQL range partition by month — partition preferred if volume is high, but a bounded DELETE is the simpler v1.
- **Read-only use cases + DTOs**: `ListRadiusEvents` (filters: client/username, NAS, VLAN/node, event type, date range, online/offline + pagination) and `ListNe8000PppoeAudit` (padrón scoped to the NE8000 NasServer: PPPoE username, status, last connection from latest `RadiusEvent`). DTOs only — never raw Prisma rows.
- **Routes** under `radius.routes.ts` (or a sibling `network-audit.routes.ts`): `GET /radius/events` and `GET /radius/ne8000/audit`, both guarded by `network.read` (mirrors `GET /radius/sessions` at `radius.routes.ts`). No `network.manage`, no DELETE — read-only by design.
- **NE8000 NAS registration**: register the Huawei NE8000 as a `NasServer` via an **idempotent seed migration** (project pattern). Design decides whether to extend `NasType` (`src/domain/entities/nas.ts:1`) with `'huawei_radius'` or reuse `'mikrotik_radius'` — depends on the BRAS's real `nasipaddress` in `radacct` (Phase 0).

### 3. ipnext-frontend (repo: ipnext-frontend)
- Two **separate** read-only pages in the same "Gestión de Red" section: `radius-logs` (Logs RADIUS) and `ne8000-audit` (Auditoría NE8000). Each: URL-backed filters + `Pagination`, following the `RecaptacionPage` / `TicketsListPage` pattern.
- Two new `Sidebar.tsx` items in "Gestión de red", each with `requiredPermission: network.read` + `RequirePermission` route guards. UI built with the **`ui-ux-pro-max`** skill (mandatory).

### Capabilities the spec agent will write (kebab-case)
1. `orchestrator-accounting-endpoint` — orchestrator `GET /accounting` (paginated, filtered, VLAN-parsed).
2. `radius-event-model` — Prisma `RadiusEvent` table + domain entity + indexes.
3. `radius-accounting-ingest-scheduler` — incremental ingest scheduler + retention/purge.
4. `radius-events-query-api` — `ListRadiusEvents` use case + `GET /radius/events` (`network.read`).
5. `ne8000-nas-registration` — register NE8000 as `NasServer` (idempotent seed) + NAS-type decision.
6. `ne8000-audit-api` — `ListNe8000PppoeAudit` use case + `GET /radius/ne8000/audit` (`network.read`).
7. `radius-orchestrator-accounting-gateway` — `listAccounting` on port + HTTP/in-memory adapters.
8. `radius-logs-page` — FE Logs RADIUS page (filters + pagination + sidebar + guard).
9. `ne8000-audit-page` — FE Auditoría NE8000 page (filters + pagination + sidebar + guard).

## Affected modules
- `freeradius-orchestrator` — new `GET /accounting` route (cross-repo).
- `prisma/schema.prisma` + `prisma/migrations/` — `RadiusEvent` table + NE8000 seed.
- `src/domain/ports/RadiusOrchestratorGateway.ts` — new `listAccounting`.
- `src/infrastructure/adapters/orchestrator/HttpRadiusOrchestratorGateway.ts` (+ in-memory) — impl.
- `src/infrastructure/scheduling/` — new `RadiusAccountingIngest` scheduler.
- `src/domain/entities/nas.ts:1` — possible `NasType` extension (`'huawei_radius'`).
- `src/application/use-cases/` — `ListRadiusEvents`, `ListNe8000PppoeAudit` (+ DTOs).
- `src/infrastructure/http/routes/radius.routes.ts` (or new `network-audit.routes.ts`).
- **⚠️ FLAG — God Object**: `src/infrastructure/http/app.ts` (617 lines, known_debt `god-object-app`) **must be touched** to wire the new scheduler and routes. This adds to the God Object. Recommendation: keep new wiring minimal; if a sibling router is added, register it with one line. Do NOT refactor app.ts in this EPIC — flag it for a separate change.
- **✅ No Splynx**: this change adds **zero** Splynx dependencies (architectural constraint respected). All RADIUS data flows through the orchestrator.
- ipnext-frontend — 2 pages + 2 sidebar items + 2 route guards (cross-repo).

## Phase 0 (must do first)
1. **Confirm the exact `GET /accounting` contract** with the orchestrator owner: query params, response shape, pagination/cursor semantics, and that the orchestrator (not the BE) parses `nasportid` → VLAN. Without this the gateway method and ingest cursor are guesswork.
2. **Confirm the NE8000 identity as a NAS**: its real `nasipaddress` value as it appears in `radacct` (needed for the idempotent seed and for `nasServerId` matching during ingest), and decide `NasType` (`'huawei_radius'` vs reuse `'mikrotik_radius'`).

## Rollback
Read-only ⇒ rollback is trivial, no operational data loss (Prominense never wrote to RADIUS):
- Drop the `RadiusEvent` table (migration down) + remove the NE8000 seed row.
- Remove the `RadiusAccountingIngest` scheduler wiring from `app.ts`.
- Remove `GET /radius/events` and `GET /radius/ne8000/audit` routes.
- Remove the 2 FE pages + sidebar items + route guards.
- The orchestrator `GET /accounting` can stay (inert, no consumers) or be removed independently.
No impact on PPPoE management, enforcement, or active sessions.

## Out of scope — Phase 2 (explicit)
Auth failures / failed logins (NE8000 `online-fail-record`). These do **not** live in the RADIUS `radacct` SQL; they require hitting the NE8000 directly with a separate integration. Named here as a future phase — **not** part of this EPIC.

## Cross-reference
- Existing active-sessions feature (sibling, NOT this): `RadiusSession` model + `ListRadiusSessions` + `GET /radius/sessions` (`network.read`) / `DELETE /radius/sessions/:id` (`network.manage`) in `src/infrastructure/http/routes/radius.routes.ts`; FE `/admin/networking/radius-sessions`.
- Orchestrator architecture (regla de oro): Prominense → orchestrator (FastAPI VIP `http://10.75.0.20:8080`, bearer) → RADIUS DB. Port: `src/domain/ports/RadiusOrchestratorGateway.ts`.
- Project memory: PPPoE/RADIUS architecture, "Acceso Sur en NE8000 BRAS" (PPPoE terminates on Huawei NE8000-1, auth RADIUS HA), "Enforcement NE8000", "RADIUS HA dual-stack VSAs".
- Scheduler pattern reference: `src/infrastructure/scheduling/*.ts` (7 existing schedulers).
- FE page pattern: `RecaptacionPage` / `TicketsListPage` (URL-backed filters + `Pagination`); sidebar `Sidebar.tsx`; skill `ui-ux-pro-max`.
- Cross-repos: ipnext-frontend (2 pages), freeradius-orchestrator (`GET /accounting`).
