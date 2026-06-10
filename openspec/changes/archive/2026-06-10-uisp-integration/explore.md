# Exploration: UISP Integration (uisp-integration)

## Executive Summary

Live API probe confirmed: 73 sites, 4009 devices, full field map verified.
`/devices` (all) takes **~5.2s** — too heavy for synchronous per-request calls, demands a live-proxy-per-site approach.
NetworkSite already exists as a full CRUD entity with `iclassNodeCode`; adding `uispSiteId String?` is a small additive migration.
Site name pattern in UISP is `[N] Nodo NombreLugar` — NOT the device naming convention `NombreApellidoLocalidad`.
The RBAC `network` module already exists with `manage_sites` action seeded — no new module needed, only new sub-actions (`view_uisp`, `manage_uisp_mapping`).
Feature flag pattern: one row in `FeatureFlag` table (`uisp-integration`), gated in routes same as `iclass-integration`.

---

## Current State

### API — UISP v2.1 (live-verified 2026-06-10)

**Base URL**: `https://190.7.234.36/nms/api/v2.1`  
**Auth**: header `x-auth-token: $UISP_TOKEN`  
**TLS**: self-signed cert → `httpsAgent: new https.Agent({ rejectUnauthorized: false })` in axios

#### GET /sites — 73 results

```json
{
  "id": "cc4fce3f-b023-4b7e-a5e2-3d6a80536856",
  "identification": {
    "id": "cc4fce3f-b023-4b7e-a5e2-3d6a80536856",
    "status": "unknown",        // 65 sites = "unknown", 8 = "active"
    "name": "[54] Nodo Municipio",
    "parent": {
      "id": "2719e573-...",
      "name": "[1] Nodo Hipico",
      "status": "unknown",
      "type": "site",
      "parentId": "..."
    },
    "type": "site",
    "suspended": false,
    "updated": "2026-06-10T04:57:49.359Z"
  },
  "description": {
    "address": null,
    "note": "Template de Seguimiento...",
    "contact": { "name": "Pablo Sarto", "phone": "2346458624", "email": null },
    "location": { "longitude": -60.01962, "latitude": -34.89844 },
    "height": 10,
    "deviceCount": 272,
    "deviceOutageCount": 33,
    "deviceListStatus": "unknown"
  }
}
```

**Field map (sites)**:
- `identification.id` → `uispSiteId` FK reference
- `identification.name` → display name (pattern: `[N] Nodo Lugar`)
- `identification.status` → `"active" | "unknown"` (65 unknown, 8 active)
- `identification.parent.id` → parent site reference
- `description.location.latitude/longitude` → coordinates
- `description.deviceCount` → device count (server-side computed)
- `description.deviceOutageCount` → outage count per site
- `description.contact.name/phone` → site contact info
- `description.note` → free-text template (rich, multi-line)

**Site hierarchy**: 67 of 73 sites have a parent. Tree depth appears 2-3 levels.

#### GET /devices?siteId={id}

Timed probes:
- `[54] Nodo Municipio` (272 devices): ~implicit in full /devices pull
- `[23] Nodo San Martin` (11 devices): **2.51s**
- Full /devices (4009 devices): **5.17s**

```json
{
  "identification": {
    "id": "001b0248-...",
    "site": { "id": "...", "name": "[45] Nodo Canepa", "status": "unknown", "type": "site" },
    "mac": "e0:63:da:f0:78:ac",
    "name": "LucianaDelorenzi2Ch",         // device naming: ClienteApellidoNodoSufijo
    "model": "LBE-5AC-Gen2",
    "modelName": "LiteBeam 5AC",
    "firmwareVersion": "8.7.14",
    "type": "airMax",
    "role": "station",                     // "station" (client CPE) | "ap" (access point)
    "authorized": true,
    "updated": "2026-06-10T01:03:31.618Z"
  },
  "overview": {
    "status": "active",                    // "active" | "disconnected" | ...
    "signal": -73,                         // dBm, null when disconnected
    "uptime": 125351,                      // seconds, null when disconnected
    "cpu": 3,                              // % integer, null when disconnected
    "ram": 39,                             // % integer, null when disconnected
    "lastSeen": "2026-06-10T04:58:11.959Z",
    "outageScore": 0.31,
    "stationsCount": null                  // non-null on APs
  },
  "ipAddress": "100.64.66.172",           // top-level! NOT in overview or networkStatus
  "ipAddressList": [],
  "location": {
    "latitude": -34.89844,
    "longitude": -60.01962
  }
}
```

**Field map (devices)**:
- `identification.id` → UISP device UUID
- `identification.name` → device display name
- `identification.model` / `modelName` → hardware model
- `identification.firmwareVersion` → firmware
- `identification.type` → `"airMax" | "airFiber" | ...`
- `identification.role` → `"station"` (client CPE) | `"ap"` (access point infrastructure)
- `identification.mac` → MAC address
- `overview.status` → `"active" | "disconnected"`
- `overview.signal` → dBm (null when offline)
- `overview.uptime` → seconds (null when offline)
- `overview.cpu` / `ram` → % (null when offline)
- `overview.lastSeen` → ISO timestamp
- `ipAddress` → top-level field (NOT in overview)

#### GET /outages?page=1&count=N

Paginated. `page` (required), `count` optional.

```json
{
  "items": [{
    "id": "0580d786-...",
    "startTimestamp": "2026-06-10T04:57:29.900Z",
    "endTimestamp": null,         // null = in progress
    "type": "unreachable",
    "inProgress": true,
    "device": {
      "id": "...", "site": { "id": "...", "name": "[34] Nodo Ovoprot", ... },
      "mac": "24:a4:3c:82:1f:a3", "ip": "100.64.60.144", "name": "VictoriaAuteriCh",
      "role": "station", "model": "P5B-300"
    },
    "site": { "id": "...", "name": "[34] Nodo Ovoprot" },
    "affectedDevices": 0
  }],
  "pagination": { ... },
  "aggregation": { ... }
}
```

**IMPORTANT**: `/outages` requires `?page=` parameter — calling without it returns 400.

---

## Site Name Pattern & Mapping Analysis

**UISP site names** (real, sampled):
```
[1] Nodo Hipico
[22] Nodo Huidobro
[54] Nodo Municipio
[55] Nodo Federacion
[47] Nodo Hospital
[71]San Jacinto           ← inconsistent formatting
[73] Parque Industrial FO ← not "Nodo" prefix
```

Pattern: `[number] Nodo NombreLugar` (90%+). Number is a numeric ID used internally.
The naming is DIFFERENT from the device naming convention (`NombreApellidoLocalidad`).

**NetworkSite entity (current)**:
```ts
interface NetworkSite {
  id: string;           // UUID (Prisma)
  name: string;         // e.g. "Nodo Central", "POP Norte"
  address: string;
  city: string;
  coordinates: { lat: number; lng: number } | null;
  type: 'pop' | 'nodo' | 'datacenter' | 'tower' | 'other';
  status: 'active' | 'inactive' | 'maintenance';
  deviceCount: number;
  clientCount: number;
  uplink: string;
  parentSiteId: string | null;
  description: string;
  iclassNodeCode: string | null;   // from #29
}
```

**Schema (prisma)**:
```prisma
model NetworkSite {
  id             String        @id @default(uuid())
  name           String
  address        String?
  city           String?
  lat            Float?
  lng            Float?
  type           String        @default("nodo")
  status         String        @default("active")
  deviceCount    Int           @default(0)
  clientCount    Int           @default(0)
  uplink         String?
  parentSiteId   String?
  parent         NetworkSite?  @relation("SiteHierarchy", ...)
  children       NetworkSite[] @relation("SiteHierarchy")
  description    String?
  createdAt      DateTime      @default(now())
  iclassNodeCode String?
}
```

**Mapping design**: UISP name `[54] Nodo Municipio` does NOT reliably match `NetworkSite.name` (which could be `"Municipio"`, `"Nodo Municipio"`, or the full UISP string). Auto-matching by substring is fragile. **Recommendation: manual mapping** with `NetworkSite.uispSiteId String?` nullable column. The admin maps each NetworkSite to its UISP site via dropdown or search. No auto-match on name.

---

## NetworkSite Today

**Ports**: `src/domain/ports/NetworkSiteRepository.ts` — CRUD interface, 5 methods.
**Entity**: `src/domain/entities/networkSite.ts`
**Prisma adapter**: `src/infrastructure/adapters/prisma/PrismaNetworkSiteRepository.ts`
**InMemory adapter**: `src/infrastructure/adapters/in-memory/InMemoryNetworkSiteRepository.ts`
**Routes**: `src/infrastructure/http/routes/networkSite.routes.ts` — GET `/`, POST `/`, GET `/:id`, PUT `/:id`, DELETE `/:id`
**Wired in**: `src/infrastructure/http/app.ts` line 1280 — `app.use('/api/network-sites', ...)`
**Used by tasks**: `ScheduledTask` references `networkSiteId` (optional). `SendTaskToIClass` reads `iclassNodeCode` from the site.

**No RBAC guard currently on NetworkSite routes** — they use only `auth` middleware (JWT), not `requirePermission`. This is a gap to close with this change.

---

## Integration Patterns to Mirror

### Adapter Pattern (GestionRealClient / IClassClient)

- Class implementing a domain Port interface
- Constructor takes `Options` object (baseUrl, credentials, timeoutMs, injectable clock/http)
- `axios.create()` with baseURL + timeout + headers
- Methods map to domain entities/DTOs via pure parser functions
- No framework dependencies in adapter

**For UISP**: same pattern, but needs `httpsAgent: new https.Agent({ rejectUnauthorized: false })` on the axios instance to handle self-signed TLS.

### Config Pattern (config.ts)

```ts
uisp: {
  baseUrl: process.env.UISP_BASE_URL ?? 'https://190.7.234.36/nms/api/v2.1',
  token: process.env.UISP_TOKEN ?? '',
  timeoutMs: parseInt(process.env.UISP_TIMEOUT_MS || '10000', 10),
},
```

- NOT in REQUIRED_VARS (opt-in like IClass — not fail-fast at boot)
- `UISP_TOKEN` is the env var name (GitHub secret + deploy.yml `-e UISP_TOKEN="${{ secrets.UISP_TOKEN }}"`)
- `UISP_BASE_URL` allows override (though 190.7.234.36 is hardcoded as default for safety)

### Feature Flag Pattern

- Row in `FeatureFlag` table: `key = 'uisp-integration'`, `enabled = false`
- Seeded in migration (idempotent `ON CONFLICT DO NOTHING`)
- Routes check flag via `GetFeatureFlag` use case — return 503 if disabled
- OR: flag check happens in the use case itself (preferred — keeps route thin)

### RBAC Pattern

**Existing `network` module** already seeded with actions: `read`, `write`, `delete`, `manage`, `manage_gpon`, `manage_sites`.

New actions needed for UISP:
- `network.view_uisp` — read UISP data (sites overview, device list, outages)
- `network.manage_uisp_mapping` — write `uispSiteId` linkage (admin-only)

Migration pattern (mirrors `20260618000000_rbac_admin_flags_permission`):
```sql
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'view_uisp'
FROM "RbacModule" m WHERE m."code" = 'network'
ON CONFLICT ("moduleId", "action") DO NOTHING;
-- + manage_uisp_mapping
-- + grant both to super_admin
```

Also: add `'view_uisp'` and `'manage_uisp_mapping'` to `KNOWN_ACTIONS` in `src/domain/entities/rbac.ts`.

---

## Live vs Mirror Decision

**Evidence**:
- `/devices` (all 4009): 5.17s — NOT acceptable for synchronous page load
- `/devices?siteId=X` (11 devices, small site): 2.51s — still slow for sync render
- `/sites` (73 sites): fast, ~200ms (estimated, not timed separately)
- `/outages?page=1`: fast

**Decision: LIVE per-request, NOT mirror/cache in DB** (V1).

Rationale:
- 4000 devices is too large to cache without a background job + sync complexity
- Per-site device list (avg ~55 devices/site) at ~2-3s is acceptable for a "loading..." UX
- V1 is a read-only view — no write-back to UISP
- Eliminates sync job, migration of device data, and stale-data problems
- Risk: UISP down = page fails → acceptable with proper error boundary + 503 response

**Caching strategy (V1)**: short TTL in-memory or no cache. Consider a 30-60s per-site cache on the BE using a simple `Map<siteId, { data, fetchedAt }>` if latency proves problematic in production.

---

## File Map Proposal

### New files

```
src/
├── domain/
│   ├── entities/
│   │   └── uisp.ts                            # UispSite, UispDevice, UispOutage DTOs
│   ├── ports/
│   │   └── UispPort.ts                        # IUispClient port interface
│   └── errors/
│       └── uisp.ts                            # UispUnavailableError, UispMappingError
├── application/
│   └── use-cases/
│       ├── GetUispSiteOverview.ts             # site + site-level metrics from UISP
│       ├── ListUispSiteDevices.ts             # devices for a mapped NetworkSite
│       └── LinkNetworkSiteToUisp.ts           # write uispSiteId to NetworkSite (admin)
├── infrastructure/
│   ├── adapters/
│   │   ├── uisp/
│   │   │   └── UispClient.ts                  # IUispClient impl (axios, TLS skip)
│   │   └── in-memory/
│   │       └── InMemoryUispClient.ts          # stub for tests
│   └── http/
│       └── routes/
│           └── uisp.routes.ts                 # GET /api/uisp/sites/:networkSiteId/overview
│                                              # GET /api/uisp/sites/:networkSiteId/devices
│                                              # GET /api/uisp/sites (list all UISP sites — for mapping UI)
│                                              # PUT /api/network-sites/:id/uisp-link (write mapping)
```

### Modified files

```
src/
├── domain/
│   └── entities/
│       └── rbac.ts                    # add 'view_uisp', 'manage_uisp_mapping' to KNOWN_ACTIONS
├── infrastructure/
│   ├── config.ts                      # add config.uisp block
│   └── http/
│       ├── app.ts                     # wire UispClient + use cases + routes
│       └── routes/
│           └── networkSite.routes.ts  # add PUT /:id/uisp-link (or new route)
prisma/
└── schema.prisma                      # add uispSiteId String? to NetworkSite
prisma/migrations/
└── YYYYMMDDHHMMSS_uisp_integration/
    └── migration.sql                  # ADD COLUMN uispSiteId + RBAC perms + FF seed
```

### Tests

```
src/__tests__/
├── application/
│   ├── GetUispSiteOverview.test.ts
│   ├── ListUispSiteDevices.test.ts
│   └── LinkNetworkSiteToUisp.test.ts
└── infrastructure/
    └── adapters/uisp/
        └── UispClient.test.ts         # parser unit tests only (no live calls)
```

---

## Approaches

### Approach 1 — Live proxy, per-site (RECOMMENDED)
Each `/api/uisp/sites/:networkSiteId/*` call proxies directly to UISP in real-time.

- **Pros**: No sync infrastructure, always fresh data, simple V1
- **Cons**: 2-5s latency per call, UISP downtime = page failure
- **Effort**: Medium

### Approach 2 — Background sync + DB cache
A scheduled job syncs UISP device list to a new `UispDevice` table periodically.

- **Pros**: Fast page load, works when UISP is temporarily down
- **Cons**: Sync job complexity, stale data risk, 4000-row table to maintain, V1 overkill
- **Effort**: High

### Approach 3 — Hybrid: sites live + devices cached
Sites fetched live (73, fast), devices cached per-site with 5min TTL in BE memory.

- **Pros**: Acceptable latency, simple cache, no DB table
- **Cons**: Memory footprint (small — 4000 devices is ~2MB JSON), restarts clear cache
- **Effort**: Medium-Low

**Recommendation**: Start with **Approach 1** (live proxy). If prod latency proves problematic after real usage, upgrade to **Approach 3** (in-memory TTL cache) without any schema changes.

---

## Affected Areas

- `src/domain/entities/networkSite.ts` — add `uispSiteId?: string | null`
- `src/domain/entities/rbac.ts` — add `view_uisp`, `manage_uisp_mapping` to KNOWN_ACTIONS
- `src/infrastructure/config.ts` — add `config.uisp` block
- `src/infrastructure/http/app.ts` — wire UispClient, use cases, route
- `prisma/schema.prisma` — `uispSiteId String?` on NetworkSite
- `prisma/migrations/` — new additive migration (ADD COLUMN + RBAC seeds + FeatureFlag seed)

---

## Decisions for Proposal

| Decision | Options | Recommendation |
|----------|---------|---------------|
| Live vs mirror | Live proxy / DB sync / hybrid TTL | **Live proxy (V1)**, TTL cache if needed |
| Mapping strategy | Auto (name match) / Manual (admin UI) | **Manual** — name patterns too inconsistent |
| URL/token config | ENV secrets / DB config | **ENV secrets** (mirrors GR/IClass pattern) |
| RBAC module | New `uisp` module / extend `network` | **Extend `network`** — already seeded, correct domain |
| Flag key | `uisp-integration` | Yes — follows naming convention |
| TLS handling | `rejectUnauthorized: false` in axios | Yes — self-signed cert, non-negotiable for V1 |
| Per-site caching | None (V1) / in-memory TTL | **None for V1**, ready for TTL upgrade |
| Outages in V1 | Yes / No | **Yes — per-site outages** (already probed, simple add) |

---

## Risks

1. **UISP latency**: `/devices?siteId=X` takes 2-3s. Sites with 200+ devices will push toward 5s. The FE page must show a loading state; the BE must set `timeout: 10000` minimum.
2. **TLS `rejectUnauthorized: false`**: This disables certificate validation entirely. Acceptable for internal infra on a private network, but must be documented and NOT used if a public endpoint is ever exposed.
3. **Token rotation**: The current token (`UISP_TOKEN`) should be rotated after integration ships. The `WORKFLOW-MULTI-REPO.md` pattern via `gh secret set UISP_TOKEN` covers this cleanly.
4. **UISP `status: "unknown"`**: 65 of 73 sites show status `"unknown"` — this is UISP's polling state, not a system error. The FE must NOT show this as a warning.
5. **No `/devices` without siteId in V1**: Fetching all 4009 devices (5.17s) must NEVER be called synchronously from a page route. Gated to background/admin only if needed later.
6. **RBAC KNOWN_ACTIONS type-safety**: Adding new action strings requires updating the const array in `rbac.ts` AND the migration — if one is missed, `requirePermission` silently blocks at runtime (fail-closed).
7. **Parent-site hierarchy**: 67/73 sites have parents. The FE site overview should display the parent chain. The current `NetworkSite.parentSiteId` field can mirror UISP's hierarchy if mapped correctly.

---

## Open Questions for Proposal

1. **Mapping UI location**: Should the UISP link field (`uispSiteId`) be editable from the existing NetworkSite edit form, or from a dedicated UISP admin page? Recommendation: existing NetworkSite edit form — adds one dropdown field.
2. **V1 scope of outages**: Show current in-progress outages per site, or full paginated history? Recommendation: current in-progress only (page=1, filter `inProgress: true`).
3. **FE sidebar placement**: New "Red / UISP" section, or under existing "Red" section? Likely under existing `Red` since NetworkSite already lives there.
4. **Per-site device filtering**: Show ALL device types (AP + station) or only stations (client CPEs)? Recommendation: all devices, with role as a column.
5. **NOC role permissions**: Should `noc` role have `network.view_uisp` by default? Recommendation: yes — NOC monitoring is their primary function.

---

## Ready for Proposal

Yes. Evidence is complete:
- UISP API field map verified live (sites + devices + outages)
- Latency data collected (5.17s full fetch, 2.51s per-site small)
- Existing patterns identified (GestionRealClient, IClassClient, FeatureFlag, RBAC)
- Mapping strategy decided (manual, `uispSiteId` nullable column)
- Architecture approach selected (live proxy V1, no sync job)
- File map complete with 7 new files + 6 modified
