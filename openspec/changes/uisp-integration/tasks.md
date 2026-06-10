# Tasks: UISP Integration (V1) — Node Mirror

## Phase 1 — Migration + Schema + Snapshot Test

- [x] 1.1 [RED] Write `src/__tests__/infrastructure/migration.uisp_mirror.test.ts` — snapshot test verifying `20260619000000_uisp_mirror` SQL content (pattern: `migration.inventory_asset_mac_unique.test.ts`)
- [x] 1.2 Create `prisma/migrations/20260619000000_uisp_mirror/migration.sql` — `UispSite` table (`id uuid PK`, `uispId TEXT UNIQUE`, `name`, `status`, `parentUispId TEXT?`, `latitude DOUBLE PRECISION?`, `longitude DOUBLE PRECISION?`, `deviceCount INT DEFAULT 0`, `outageCount INT DEFAULT 0`, `contact TEXT?`, `missingSince TIMESTAMP(3)?`, `lastSyncAt TIMESTAMP(3)`, `createdAt TIMESTAMP(3) DEFAULT now()`, `updatedAt TIMESTAMP(3)` NO default); indexes on `status`, `missingSince`
- [x] 1.3 Extend `prisma/migrations/20260619000000_uisp_mirror/migration.sql` — `UispDevice` table (`id uuid PK`, `uispId TEXT UNIQUE`, `uispSiteId TEXT` NO FK, `name`, `model`, `modelName?`, `type?`, `role?`, `mac?`, `ip?`, `firmware?`, `status`, `signal INT?`, `uptime BIGINT?`, `lastSeenAt TIMESTAMP(3)?`, `missingSince TIMESTAMP(3)?`, `lastSyncAt TIMESTAMP(3)`, `createdAt DEFAULT now()`, `updatedAt` NO default); indexes on `uispSiteId`, `status`, `missingSince`
- [x] 1.4 Extend `prisma/migrations/20260619000000_uisp_mirror/migration.sql` — RBAC: idempotent `INSERT INTO "Module"` for `uisp`, `INSERT INTO "Permission"` for `uisp:read` and `uisp:manage` (ON CONFLICT DO NOTHING), `INSERT INTO "RolePermission"` granting both to `super_admin` (ON CONFLICT DO NOTHING), `INSERT INTO "FeatureFlag"` for `uisp-sync` `enabled=false` (ON CONFLICT DO NOTHING) — SCEN-SEC-01, SCEN-SEC-02
- [x] 1.5 Add `UispSite` and `UispDevice` models to `prisma/schema.prisma` matching the SQL exactly (`uptime BigInt?`, `latitude Float?`, `longitude Float?`, `uispSiteId String` no `@relation`)
- [x] 1.6 [GREEN] Run `npx prisma generate` in worktree; confirm snapshot test passes
- [x] 1.7 `npx tsc --noEmit` gate — confirm no TS errors introduced

## Phase 2 — Domain Layer

- [x] 2.1 [RED] Write `src/__tests__/domain/entities/uisp.test.ts` — factory tests for `UispSite` and `UispDevice` entity shapes (all required fields, nullable fields default null)
- [x] 2.2 Create `src/domain/entities/uisp.ts` — `UispSite` entity + factory, `UispDevice` entity + factory (`uptime` typed `bigint | null`) — [GREEN]
- [x] 2.3 Create `src/domain/errors/uisp.ts` — `UispUnavailableError extends DomainError` with code `UISP_UNAVAILABLE`
- [x] 2.4 Create `src/domain/ports/UispClient.ts` — `interface UispClient { listSites(): Promise<UispSite[]>; listDevices(): Promise<UispDevice[]>; }`
- [x] 2.5 Create `src/domain/ports/UispSiteRepository.ts` — `interface UispSiteRepository { upsert(site: UispSite): Promise<void>; listAll(): Promise<UispSite[]>; findByUispId(id: string): Promise<UispSite | null>; markMissing(uispIds: string[], since: Date): Promise<void>; clearMissing(uispIds: string[]): Promise<void>; }`
- [x] 2.6 Create `src/domain/ports/UispDeviceRepository.ts` — same shape for devices (`upsert`, `listBySiteId`, `findByUispId`, `markMissing`, `clearMissing`)
- [x] 2.7 Modify `src/domain/entities/rbac.ts` — add `'uisp'` to `RBAC_MODULES`; `'read'` and `'manage'` already in `KNOWN_ACTIONS` (base actions) — SCEN-SEC-01

## Phase 3 — Infrastructure Adapters

- [x] 3.1 [RED] Write `src/__tests__/infrastructure/InMemoryUispClient.test.ts` — tests for field mapping (ipAddress top-level, null signal/uptime, missing optional fields) using raw UISP fixture data
- [x] 3.2 Create `src/infrastructure/adapters/uisp/UispClient.ts` — axios instance (`baseURL`, `timeout:30000`, `x-auth-token` header, `httpsAgent: new https.Agent({rejectUnauthorized:false})`); `listSites()` maps `identification.id`→uispId, `identification.name`→name, `identification.status`→status, `identification.parent.id`→parentUispId, `description.location.latitude/longitude`, `description.deviceCount`, `description.deviceOutageCount`, `description.contact.name`→contact; `listDevices()` maps `identification.*`, `ipAddress` (top-level), `overview.status/signal/uptime/lastSeen`, `identification.site.id`→uispSiteId; transport errors → `UispUnavailableError` — [GREEN]
- [x] 3.3 Create `src/infrastructure/adapters/in-memory/InMemoryUispClient.ts` — `implements UispClient`, stores `sites: UispSite[]` and `devices: UispDevice[]`, setters for test setup
- [x] 3.4 [RED] Write `src/__tests__/infrastructure/PrismaUispSiteRepository.test.ts` — port contract test verifying `PrismaUispSiteRepository` and `InMemoryUispSiteRepository` implement the same behavior (upsert idempotent, markMissing, clearMissing)
- [x] 3.5 Create `src/infrastructure/adapters/in-memory/InMemoryUispSiteRepository.ts` — `implements UispSiteRepository` with `Map<string, UispSite>` store
- [x] 3.6 Create `src/infrastructure/adapters/in-memory/InMemoryUispDeviceRepository.ts` — `implements UispDeviceRepository` with `Map<string, UispDevice>` store
- [x] 3.7 Create `src/infrastructure/adapters/prisma/PrismaUispSiteRepository.ts` — chunked upsert (200/chunk, `$transaction`, sequential `await`), `markMissing`, `clearMissing`, `listAll`, `findByUispId` — [GREEN]
- [x] 3.8 Create `src/infrastructure/adapters/prisma/PrismaUispDeviceRepository.ts` — same pattern as sites — [GREEN]

## Phase 4 — SyncUispMirror + Scheduler + SyncState

- [x] 4.1 [RED] Write `src/__tests__/application/use-cases/SyncUispMirror.test.ts` — tests for SCEN-MIR-01 (new site created), SCEN-MIR-02 (existing site updated), SCEN-MIR-03 (idempotent), SCEN-MIR-04 (device FK), SCEN-MIR-05 (device changes site), SCEN-MIR-06 (site missingSince set), SCEN-MIR-07 (site missingSince cleared), SCEN-MIR-08 (device missingSince set); use `InMemoryUispClient` + in-memory repos
- [x] 4.2 Create `src/application/use-cases/SyncUispMirror.ts` — pulls sites+devices via `UispClient`, upserts in chunks of 200 via repos, marks missing (seen set diff), clears reappeared, saves `SyncState` entity `'uisp-mirror'` with counts — [GREEN]
- [x] 4.3 [RED] Write `src/__tests__/application/UispSyncScheduler.test.ts` — SCEN-SYNC-01 (flag OFF → no call), SCEN-SYNC-02 (lock held → skip), SCEN-SYNC-03 (env absent → graceful skip), SCEN-SYNC-04 (UISP 5xx → mirror intact, `lastError` updated)
- [x] 4.4 Create `src/infrastructure/scheduling/UispSyncScheduler.ts` — mirrors `TaskAutocompleteScheduler`: `inFlight` + `DistributedLock('uisp-sync')` + flag gate `'uisp-sync'` + `triggerNow()` returning `TriggerResult`; env check (`UISP_BASE_URL`/`UISP_TOKEN`) before running — [GREEN] — SCEN-SYNC-01..04
- [x] 4.5 Create `src/infrastructure/scheduling/bootstrapUispSync.ts` — wires `PrismaUispSiteRepository`, `PrismaUispDeviceRepository`, `UispClient`, `SyncUispMirror`, `UispSyncScheduler`; returns scheduler; exported for `main.ts`
- [x] 4.6 Modify `src/main.ts` — import `bootstrapUispSync`, call `bootstrapUispSync(300_000).start()` after existing schedulers

## Phase 5 — Read Use Cases + Routes + app.ts

- [x] 5.1 [RED] Write `src/__tests__/application/use-cases/ListUispSites.test.ts` — SCEN-API-01 (200 with sites), SCEN-API-02 (status unknown served as-is)
- [x] 5.2 Create `src/application/use-cases/ListUispSites.ts` — queries `UispSiteRepository.listAll()`, returns `{ sites: UispSiteRow[] }` DTO (exact wire contract from design) — [GREEN]
- [x] 5.3 [RED] Write `src/__tests__/application/use-cases/GetUispSiteDetail.test.ts` — SCEN-API-04 (site+devices), SCEN-API-05 (404)
- [x] 5.4 Create `src/application/use-cases/GetUispSiteDetail.ts` — `findByUispId` + `listBySiteId`; throws `UispSiteNotFoundError` (404); returns `{ site: UispSiteDetail, devices: UispDeviceRow[] }` — [GREEN]
- [x] 5.5 [RED] Write `src/__tests__/application/use-cases/GetUispSyncStatus.test.ts` — SCEN-API-06 (null lastSyncAt when never run), checks `configured` and `enabled` booleans
- [x] 5.6 Create `src/application/use-cases/GetUispSyncStatus.ts` — reads `SyncStateRepository.get('uisp-mirror')`, reads flag `uisp-sync`, returns wire contract DTO — [GREEN]
- [x] 5.7 Create `src/application/use-cases/TriggerUispSync.ts` — calls `scheduler.triggerNow()`; maps `TriggerResult` to HTTP response shape: `{ queued:true }` or `{ queued:false, reason }` — SCEN-SYNC-05, SCEN-SYNC-06
- [x] 5.8 [RED] Write `src/__tests__/infrastructure/uisp.routes.test.ts` — supertest + in-memory repos; SCEN-API-01..06 (list/detail/status guards + shapes), SCEN-API-03 (403 without uisp:read), SCEN-SYNC-05 (202 triggerNow), SCEN-SYNC-06 (409 already running)
- [x] 5.9 Create `src/infrastructure/http/routes/uisp.routes.ts` — `GET /api/uisp/sites` (requirePerm uisp:read), `GET /api/uisp/sites/:uispId` (requirePerm uisp:read), `GET /api/uisp/sync/status` (requirePerm uisp:read), `POST /api/uisp/sync` (requirePerm uisp:manage) — [GREEN]
- [x] 5.10 Modify `src/infrastructure/config.ts` — add `config.uisp = { baseUrl: process.env.UISP_BASE_URL, token: process.env.UISP_TOKEN }` block (opt-in, NO fail-fast)
- [x] 5.11 Modify `src/infrastructure/http/app.ts` — wire `UispSiteRepository`, `UispDeviceRepository`, use-cases, `uisp.routes.ts` under `/api/uisp`; inject `scheduler` reference for `TriggerUispSync`
- [x] 5.12 [RED→GREEN] Write `src/__tests__/infrastructure/http/uisp-composition.test.ts` — composition-root assertions: `UispSiteRepository` implements port, `UispDeviceRepository` implements port, router mounted at `/api/uisp`
- [ ] 5.13 [ORCHESTRATOR] Add `UISP_BASE_URL` and `UISP_TOKEN` as GitHub secrets via `gh secret set`; add two `-e UISP_BASE_URL="${{ secrets.UISP_BASE_URL }}"` and `-e UISP_TOKEN="${{ secrets.UISP_TOKEN }}"` lines to `.github/workflows/deploy.yml` "Deploy container" step, mirroring existing GR/IClass env rows

## Phase 6 — Frontend

- [ ] 6.1 Create `src/types/uisp.ts` (FE) — `UispSiteRow`, `UispSiteDetail`, `UispDeviceRow`, `UispSyncStatus` matching wire contracts exactly (`uptime: string | null`)
- [ ] 6.2 Create `src/api/uisp.ts` (FE) — `fetchUispSites()`, `fetchUispSiteDetail(uispId)`, `fetchUispSyncStatus()`, `postUispSync()` using existing axios/fetch pattern
- [ ] 6.3 Create `src/hooks/useUispSites.ts`, `useUispSiteDetail.ts`, `useUispSyncStatus.ts` (FE) — SWR/React Query hooks; `useUispSyncStatus` exposes `configured` and `enabled`
- [ ] 6.4 Modify `Sidebar.tsx` — add `{ to:'/admin/networking/nodes', label:'Nodos', requiredPermission:'uisp.read' }` to existing **"Gestión de red"** group — SCEN-FE-06
- [ ] 6.5 Create `src/pages/networking/NodesPage.tsx` — table (name/status badge/deviceCount/outageCount/lastSyncAt) + client-side search; empty state "La sincronización nunca fue ejecutada" when `lastSyncAt=null` (SCEN-FE-02), empty state "UISP no configurado" when `configured=false` (SCEN-FE-03); gate `uisp.read`; "Sincronizar ahora" button gate `uisp.manage` (hidden/disabled otherwise) — SCEN-FE-01, SCEN-FE-07
- [ ] 6.6 Create `src/pages/networking/NodeDetailPage.tsx` (`/admin/networking/nodes/:uispId`) — header (name, status, lat/lng, parentUispId, contact) + device table (name/model/type/status badge/signal semáforo airMax />-60 excelente/-60..-70 buena/-70..-80 regular/<-80 crítica/uptime humanized/ip); badge "missing" when `missingSince != null` — SCEN-FE-04, SCEN-FE-05
- [ ] 6.7 Create `src/components/settings/UispSyncCard.tsx` — sync status card in networking settings area (last sync, site/device counts, flag toggle `uisp-sync`, "Sincronizar ahora" button); mirrors `IClassFlagBody`/`AutomationsBody` pattern; both controls gate `uisp.manage`; shows "no configurado" when `configured=false`
- [ ] 6.8 Add routes for `/admin/networking/nodes` and `/admin/networking/nodes/:uispId` to the FE router
- [ ] 6.9 [RED] Write FE tests (vitest) — SCEN-FE-01 (73 rows rendered), SCEN-FE-02 (empty state sync never ran), SCEN-FE-03 (empty state not configured), SCEN-FE-04 (detail 11 devices), SCEN-FE-05 (missing badge), SCEN-FE-06 (sidebar visibility), SCEN-FE-07 (sync button hidden without uisp:manage) — [GREEN]

## Phase 7 — Verify

- [ ] 7.1 Run `npx jest --runInBand` BE — all SCEN-MIR/SYNC/API/SEC covered; 0 failures
- [ ] 7.2 Run `npx tsc --noEmit` BE — 0 errors
- [ ] 7.3 Run `npx vitest run` FE — all SCEN-FE-01..07 pass
- [ ] 7.4 Run `npx tsc --noEmit` FE — 0 errors
- [ ] 7.5 [ORCHESTRATOR] Dry-run migration against staging DB — verify idempotency (run twice, 0 errors)
- [ ] 7.6 Verify port parity: `InMemoryUispSiteRepository` and `PrismaUispSiteRepository` both satisfy `UispSiteRepository` port (composition test)
- [ ] 7.7 Verify `app.ts` wiring test (`uisp-composition.test.ts`) passes — confirms no regressions in DI
