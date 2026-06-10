# Design: UISP Integration (V1) — Node Mirror

## Technical Approach

Owned **mirror** (not live-proxy). `UispSyncScheduler` runs every 5 min (fixed), gated by flag `uisp-sync` (OFF) + `PgAdvisoryLock('uisp-sync')`, mirroring `TaskAutocompleteScheduler` (`inFlight` + lock + `unref` timer + `triggerNow()`). `SyncUispMirror` pulls `/sites` + `/devices` via `UispClient` (axios, self-signed TLS), upserts by `uispId`, stamps `missingSince` on vanished rows, clears it on reappearance, persists run state. All reads serve the DB. RBAC `uisp` module (`read`/`manage`), super_admin grant, all in one hand-authored migration. `config.uisp` is opt-in (NO fail-fast).

## Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Live vs mirror | **Mirror** | `/devices` full = 5.17s; unacceptable per-request. Mirror = DB reads <50ms. |
| Device→site link | **Denormalized `uispSiteId TEXT`** (UISP UUID, NO internal FK) | 4009-row upsert every 5min; an FK to internal `UispSite.id` forces a lookup/join per device row + ordering (sites before devices). Storing UISP's site UUID lets each device upsert independently, idempotent, order-free. Indexed for joins. |
| lat/lng type | **`Float?`** | Coordinates are display-only (no money math). Matches existing `NetworkSite.lat/lng Float?`. |
| uptime type | **`BigInt?`** | seconds can exceed Int32 (>68 yrs unlikely but BigInt is safe + free); `null` when offline. Mapped to string in DTO. |
| Bulk upsert strategy | **Chunked `$transaction` of per-row `upsert`, chunk=200, sequential `await`** | Prisma has no native bulk-upsert. `createMany` can't update. 4009 rows / 200 = ~21 chunks, each a tx; `await` between chunks yields the event loop so the 5-min cron never blocks request handling. |
| Sync state store | **Reuse `SyncState`** (`entity='uisp-mirror'`) | Existing singleton-by-key table (`SyncStateRepository`). `lastRunAt`, `lastResult`, `itemsSynced` already fit. No new table. counts JSON packed into `lastResult`. |
| RBAC | **New `uisp` module** + `read`/`manage` | Proposal scope; `action` col is VARCHAR(64), `read`/`manage` valid. Add `'uisp'` to `RBAC_MODULES` in `rbac.ts`. |
| Interval | **Fixed 5min in main.ts** | V1 simplicity; no config table needed. |
| Devices pagination | **Single `GET /devices` call** | Explore: one call returns all 4009 in 5.17s, no pagination param required (unlike `/outages`). |

## Data Flow

    UispSyncScheduler (5min, flag+lock gate)
      └─→ SyncUispMirror.execute()
            ├─ UispClient.listSites()   → GET /sites    (parse identification/description)
            ├─ UispClient.listDevices() → GET /devices  (parse identification/overview/ipAddress top-level)
            ├─ upsert sites  (chunk 200, tx)  ─┐
            ├─ upsert devices (chunk 200, tx) ─┤→ Postgres (UispSite / UispDevice)
            ├─ missingSince stamp (NOT IN seen uispIds) / clear (reappeared)
            └─ SyncStateRepository.save({entity:'uisp-mirror', lastResult: counts})
    HTTP reads → UispSiteRepository / UispDeviceRepository (DB only, no UISP call)

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `prisma/migrations/20260619000000_uisp_mirror/migration.sql` | Create | `UispSite`+`UispDevice` tables, indexes, `uisp` module+perms+grant, `uisp-sync` flag (all idempotent) |
| `prisma/schema.prisma` | Modify | `UispSite`, `UispDevice` models |
| `src/domain/entities/uisp.ts` | Create | `UispSite`, `UispDevice` DTOs |
| `src/domain/errors/uisp.ts` | Create | `UispUnavailableError` |
| `src/domain/ports/UispClient.ts` | Create | `listSites()` / `listDevices()` port |
| `src/domain/ports/UispSiteRepository.ts` `UispDeviceRepository.ts` | Create | mirror repos (upsert/list/get/markMissing) |
| `src/domain/entities/rbac.ts` | Modify | add `'uisp'` to `RBAC_MODULES` |
| `src/application/use-cases/SyncUispMirror.ts` | Create | sync orchestration + counts |
| `src/application/use-cases/{ListUispSites,GetUispSiteDetail,GetUispSyncStatus,TriggerUispSync}.ts` | Create | read + manual trigger |
| `src/infrastructure/adapters/uisp/UispClient.ts` | Create | axios+httpsAgent, mappers |
| `src/infrastructure/adapters/in-memory/InMemoryUispClient.ts` | Create | twin |
| `src/infrastructure/adapters/prisma/Prisma{UispSite,UispDevice}Repository.ts` | Create | chunked upsert |
| `src/infrastructure/scheduling/UispSyncScheduler.ts` + `bootstrapUispSync.ts` | Create | mirror TaskAutocomplete |
| `src/infrastructure/http/routes/uisp.routes.ts` | Create | `/api/uisp/*` |
| `src/infrastructure/config.ts` | Modify | `config.uisp` block |
| `src/infrastructure/http/app.ts` | Modify | wire repos/use-cases/router under `/api/uisp` |
| `src/main.ts` | Modify | `bootstrapUispSync(300000)` + `.start()` |
| `.github/workflows/deploy.yml` | Modify | `-e UISP_BASE_URL` / `-e UISP_TOKEN` lines |

## Interfaces / Contracts

**Prisma (migration SQL — hand-authored, idempotent, `updatedAt` NO default):**
```
UispSite(id uuid PK, uispId TEXT UNIQUE, name, status, parentUispId TEXT?,
  latitude DOUBLE PRECISION?, longitude DOUBLE PRECISION?, deviceCount INT def 0,
  outageCount INT def 0, contact TEXT?, missingSince TIMESTAMP(3)?, lastSyncAt TIMESTAMP(3),
  createdAt TIMESTAMP(3) def now, updatedAt TIMESTAMP(3) /*no default*/)
  idx(status), idx(missingSince)
UispDevice(id uuid PK, uispId TEXT UNIQUE, uispSiteId TEXT /*UISP site UUID, no FK*/,
  name, model, modelName?, type?, role?, mac?, ip?, firmware?, status, signal INT?,
  uptime BIGINT?, lastSeenAt TIMESTAMP(3)?, missingSince TIMESTAMP(3)?, lastSyncAt TIMESTAMP(3),
  createdAt def now, updatedAt /*no default*/)
  idx(uispSiteId), idx(status), idx(missingSince)
```
Field map (explore): `identification.id`→uispId; `description.location.lat/lng`; `description.deviceCount/deviceOutageCount`; `description.contact.name`→contact; device `ipAddress` **top-level**; `overview.signal/uptime/status/lastSeen`; `identification.site.id`→uispSiteId.

**Wire contracts (exact):**
```
GET /api/uisp/sites            [uisp.read]  → { sites: UispSiteRow[] }
  UispSiteRow = { uispId, name, status, deviceCount, outageCount, lastSyncAt, missingSince }
GET /api/uisp/sites/:uispId    [uisp.read]  → { site: UispSiteDetail, devices: UispDeviceRow[] }
  UispSiteDetail = { uispId, name, status, parentUispId, latitude, longitude, contact, deviceCount, outageCount, lastSyncAt, missingSince }
  UispDeviceRow  = { uispId, name, model, modelName, type, role, status, signal, uptime(string|null), ip, mac, firmware, lastSeenAt, missingSince }
GET /api/uisp/sync/status      [uisp.read]  → { lastRunAt, lastResult, itemsSynced, sites, devices, missing, durationMs, configured(bool), enabled(bool) }
POST /api/uisp/sync            [uisp.manage]→ { queued } | { queued:false, reason:'already-running'|'flag-disabled' }
```
`status:"unknown"` is normal polling state — FE must NOT flag it.

**UispClient port:**
```ts
interface UispClient { listSites(): Promise<UispSite[]>; listDevices(): Promise<UispDevice[]>; }
```
Adapter: `axios.create({ baseURL, timeout:30000, headers:{'x-auth-token':token}, httpsAgent: new https.Agent({rejectUnauthorized:false}) /* self-signed internal cert */ })`; transport errors → `UispUnavailableError`.

## FE Changes

- **Sidebar**: add `{ to:'/admin/networking/nodes', label:'Nodos', requiredPermission:'uisp.read' }` to the existing **"Gestión de red"** group (`Sidebar.tsx`). (Routes use `/admin/networking/*` house convention, not the prompt's `/admin/network/*`.)
- **List page** `/admin/networking/nodes`: table (73 rows) name/status/deviceCount/outages/lastSync + client-side search. Empty states: "sync nunca corrió" / "UISP no configurado".
- **Detail** `/admin/networking/nodes/:uispId`: header (general data) + device table name/model/type/status/**signal semáforo airMax** (>-60 excelente, -60..-70 buena, -70..-80 regular, <-80 crítica), uptime humanized, ip, "no visto" badge when `missingSince`.
- **Settings**: UISP sync card (estado + flag toggle + "Sincronizar ahora", gated `uisp.manage`) in the networking settings area, mirroring `IClassFlagBody`/`AutomationsBody` flag-toggle pattern.

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Unit | `UispClient` field mappers (ipAddress top-level, null signal/uptime, missing fields) | pure parser tests, no live calls |
| Unit | `SyncUispMirror`: upsert, missingSince stamp/clear, counts, chunking | `InMemoryUispClient` + in-memory repos |
| Unit | scheduler flag-OFF skip, lock-held skip, `triggerNow` reasons | in-memory lock + flag |
| Integration | `/api/uisp/*` guards (uisp.read/manage) + DTO shape | supertest + in-memory repos |
| Composition | adapter parity (Prisma vs InMemory implement same port) + app.ts wiring assert | port contract test |

**Budget**: 4009-row upsert in ~21 chunked txs, `await` between chunks → event loop yields; lock held seconds, not minutes. Sync never runs synchronously on a request.

## Migration / Rollout

One migration `20260619000000_uisp_mirror`: tables + indexes + `uisp` module/perms + super_admin grant + `uisp-sync` flag (OFF). Flag OFF = cron dormant, reads still serve last data. Rollback: flag OFF, then down-migration drops tables + `uisp` RBAC rows + flag. No NetworkSite/IClass data touched.

**Env**: `UISP_BASE_URL` + `UISP_TOKEN` as GitHub secrets (`gh secret set`, done by orchestrator — apply agent does NOT touch secrets) + two `-e` lines in `deploy.yml` "Deploy container" step, mirroring the GR/IClass `-e VAR="${{ secrets.VAR }}"` rows.

## Open Questions

- [ ] Confirm `/devices` truly needs no pagination at 4009 rows in prod (explore measured one full call; UISP may cap response size under load).
