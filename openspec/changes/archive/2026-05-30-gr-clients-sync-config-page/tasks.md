# Tasks — gr-clients-sync-config-page (Backend)

**Status**: ready
**Repo**: `ipnext-backend`
**Strict TDD**: ACTIVE — every implementation task is preceded by a failing-test task. RED → GREEN → REFACTOR.
**Test runner**: `npx jest` · **Quality gate**: `npx tsc --noEmit`
**Layering**: domain ← application ← infrastructure. Ports first → use-cases (in-memory tested) → Prisma adapters → HTTP (supertest, incl. RBAC 403) → scheduler/bootstrap → wiring. Never run `npm run build`.
**Template**: replica of `gestion-real-installation-ingest` config slice. Deltas: `estados` (not project FKs), RBAC-guarded routes, flag-gated sync use-case.

---

## Phase 1 — Schema & Migrations (additive)

- [x] 1.1 In `prisma/schema.prisma`, add model `GestionRealSyncConfig` (`id String @id @default("singleton")`, `intervalMs Int @default(180000)`, `estados String @default("1,2,3,4,6")`, `updatedAt DateTime @updatedAt`). No FKs, no indexes.
- [x] 1.2 Generate the table migration additively (`prisma migrate diff`, no DB) at `prisma/migrations/20260530000000_gr_sync_config/migration.sql` (timestamp LATER than `20260529230000`). User applies via `npm run prisma:migrate`.
- [x] 1.3 Hand-write idempotent flag seed at `prisma/migrations/20260530010000_seed_gr_sync_flag/migration.sql`: `INSERT INTO "FeatureFlag" ("key","enabled","updatedAt") VALUES ('gestion-real-sync', true, NOW()) ON CONFLICT ("key") DO NOTHING;` (seed **true** — sync is live; mirror `20260529020000_seed_gr_ingest_flag` but value `true`).

## Phase 2 — Domain Port

- [x] 2.1 Create `src/domain/ports/GestionRealSyncConfigRepository.ts`: `SyncConfig` type (`intervalMs: number`, `estados: string[]`) + interface `get(): Promise<SyncConfig>` / `update(patch: Partial<SyncConfig>): Promise<SyncConfig>`. Mirror `GestionRealIngestConfigRepository`.

## Phase 3 — In-memory adapter (TDD)

- [x] 3.1 [RED] Create `src/__tests__/infrastructure/adapters/in-memory/InMemoryGestionRealSyncConfigRepository.test.ts` — first `get()` returns defaults `{ intervalMs: 180000, estados: ["1","2","3","4","6"] }` (REQ-CFG-1); `update({ intervalMs })` then `get()` round-trips, `estados` untouched; `update({ estados: ["1","6"] })` REPLACES (not merge); confirm FAILS.
- [x] 3.2 [GREEN] Create `src/infrastructure/adapters/in-memory/InMemoryGestionRealSyncConfigRepository.ts` — merge partial patch; `estados` replaces wholesale; defaults until first write. Mirror `InMemoryGestionRealIngestConfigRepository`.

## Phase 4 — DTO + Zod (TDD)

- [x] 4.1 [RED] Create `src/__tests__/application/dto/gestionRealSync.dto.test.ts` — `toSyncConfigDTO` maps domain→DTO (no `id`/`updatedAt`); `UpdateSyncConfigSchema` accepts `{ intervalMs: 300000 }`, `{ estados: ["1","6"] }`, `{}`; rejects `intervalMs: "soon"`, `intervalMs: 0`, `estados: ["9"]`; confirm FAILS.
- [x] 4.2 [GREEN] Create `src/application/dto/gestionRealSync.dto.ts` — `SyncConfigDTO { intervalMs; estados: string[] }`, `toSyncConfigDTO`, `ALLOWED_ESTADOS = ['1','2','3','4','6']`, `UpdateSyncConfigSchema = z.object({ intervalMs: z.number().int().positive(), estados: z.array(z.enum(ALLOWED_ESTADOS)) }).partial()`, `UpdateSyncConfigInput` type.

## Phase 5 — Config use-cases (TDD, in-memory port)

- [x] 5.1 [RED] Create `src/__tests__/application/gestion-real-sync/GetSyncConfig.test.ts` — returns current config as DTO (REQ-GETCFG-1); defaults before any write; confirm FAILS.
- [x] 5.2 [GREEN] Create `src/application/use-cases/GetSyncConfig.ts` — `(config)` → `toSyncConfigDTO(await config.get())`. Mirror `GetIngestConfig`.
- [x] 5.3 [RED] Create `src/__tests__/application/gestion-real-sync/UpdateSyncConfig.test.ts` — `update({ intervalMs })` returns updated DTO, estados untouched (REQ-PUTCFG-1); `update({ estados })` replaces; confirm FAILS.
- [x] 5.4 [GREEN] Create `src/application/use-cases/UpdateSyncConfig.ts` — `(config)`; `execute(patch) → toSyncConfigDTO(await config.update(patch))`. NO ProjectRepository, NO FK check (pure partial patch).

## Phase 6 — Prisma adapter

- [x] 6.1 [GREEN] Create `src/infrastructure/adapters/prisma/PrismaGestionRealSyncConfigRepository.ts` — singleton `id="singleton"` upsert via `(prisma as any).gestionRealSyncConfig`; `get()` returns defaults when row absent; `string ⇄ string[]` mapping (`estados` stored comma-joined, exposed as array); build `update` data only from present keys. Mirror `PrismaGestionRealIngestConfigRepository`. (No unit test — exercised via integration; matches ingest convention.)

## Phase 7 — Flag-gate the sync use-case (TDD)

- [x] 7.1 [RED] Extend `src/__tests__/application/.../SyncGestionRealClients.test.ts` (or new sibling) with `InMemoryFeatureFlagRepository`: flag `gestion-real-sync` = false → `fetchClients` NOT called, no `gr-clients` SyncState write, result zeroed/skipped (REQ-FLAG-1); flag missing → same; flag true → existing happy path still runs; confirm new assertions FAIL.
- [x] 7.2 [GREEN] In `src/application/use-cases/SyncGestionRealClients.ts`, inject `FeatureFlagRepository`; at the START of `execute()` read `get('gestion-real-sync')`; when absent/disabled return a zeroed skipped `SyncRunResult` BEFORE any GR call or state save. Mirror `IngestGestionRealOrders` flag check. Update `SyncRunResult` (add optional `skipped?: true` or return zeros).

## Phase 8 — HTTP routes (TDD supertest, incl. RBAC 403)

- [x] 8.1 [RED] Create `src/__tests__/infrastructure/http/routes/gestionRealSync.routes.test.ts` (supertest + in-memory adapters + InMemoryRbac* wiring like `rbacRoles.routes.test.ts`):
  - `GET  /sync/config` with `gestionReal:read` → 200 DTO `{ intervalMs, estados: string[] }`, no raw entity (REQ-GETCFG-1).
  - `GET  /sync/config` no perm → 403 `PERMISSION_DENIED` `{ module:'gestionReal', action:'read' }` (REQ-RBAC-1).
  - `GET  /sync/config` super_admin (no explicit perm) → 200 (short-circuit).
  - `GET  /sync/status` with `gestionReal:read` → 200 status view; no perm → 403.
  - `PUT  /sync/config` with `gestionReal:write` + `{ intervalMs: 300000 }` → 200 updated DTO (REQ-PUTCFG-1).
  - `PUT  /sync/config` with only `gestionReal:read` → 403 `{ action:'write' }`, config unchanged (REQ-RBAC-2).
  - `PUT  /sync/config` `intervalMs: "soon"` → 400 `VALIDATION_ERROR`; `estados: ["9"]` → 400; `intervalMs: 0` → 400 (REQ-PUTCFG-2).
  - Confirm all FAIL.
- [x] 8.2 [GREEN] Create `src/infrastructure/http/routes/gestionRealSync.routes.ts` — `createGestionRealSyncRouter(authProvider, requirePerm, getSyncConfig, updateSyncConfig, getSyncStatus)`. Per route: `auth` → `requirePerm(...)` → handler. `PUT` does `UpdateSyncConfigSchema.safeParse` → 400 `VALIDATION_ERROR` inline (repo convention). All responses via DTO. (Pass `requirePerm` in so the router stays decoupled from `app.ts` singletons.)

## Phase 9 — Bootstrap & app wiring

- [x] 9.1 [GREEN] In `src/infrastructure/scheduling/bootstrapGestionRealSync.ts`: build `PrismaGestionRealSyncConfigRepository`; `const persisted = await syncConfig.get()` ONCE; pass `intervalMs: persisted.intervalMs` to the scheduler and `estados: persisted.estados` to `SyncGestionRealClients`; inject `PrismaFeatureFlagRepository` into the sync UC. Keep env (`gr.intervalMs`/`gr.estados`) as the ultimate fallback; `GR_SYNC_ENABLED` still gates returning `null`. Make the function `async` if needed (mirror `bootstrapGestionRealIngest`); update `main.ts` call site to `.then(...)` if the signature becomes async.
- [x] 9.2 [GREEN] In `src/infrastructure/http/app.ts`, instantiate `PrismaGestionRealSyncConfigRepository` + `GetSyncConfig`/`UpdateSyncConfig`, reuse the existing `GetGestionRealSyncStatus`, and wire one line: `app.use('/api/gestion-real/sync', createGestionRealSyncRouter(authAdapter, requirePerm, ...))`. Do NOT disturb the existing `/api/gestion-real` read-only status mount.

## Phase 10 — Quality Gates

- [x] 10.1 Run the feature test set (`npx jest gestion-real-sync gestionRealSync SyncGestionRealClients`) — GREEN.
- [x] 10.2 Run `npx tsc --noEmit` — net-new delta 0 vs. the pre-existing RBAC/Prisma baseline (new table uses `(prisma as any)` accessor so no generated-client dependency).
- [x] 10.3 Draft conventional commit (user commits): `feat(gr-sync): configurable client sync (intervalMs + estados) via RBAC-guarded settings endpoints + gestion-real-sync flag`.

---

## Task Summary

| Phase | Focus | Type | Count |
|-------|-------|------|-------|
| 1 | Schema & migrations | additive | 3 |
| 2 | Domain port | GREEN | 1 |
| 3 | In-memory adapter | RED+GREEN | 2 |
| 4 | DTO + Zod | RED+GREEN | 2 |
| 5 | Config use-cases | RED+GREEN | 4 |
| 6 | Prisma adapter | GREEN | 1 |
| 7 | Flag-gate sync UC | RED+GREEN | 2 |
| 8 | HTTP routes (+RBAC 403) | RED+GREEN | 2 |
| 9 | Bootstrap & app wiring | GREEN | 2 |
| 10 | Quality gates | gate | 3 |
| **Total** | | | **22 tasks** |

**Phases**: 10 · dependency-ordered: schema → port → in-memory adapter → DTO → use-cases → Prisma adapter → flag-gate → routes(RBAC) → bootstrap/wiring → gates.

**TDD note**: Phases 3, 4, 5, 7, 8 are strict RED→GREEN (test written and confirmed failing before implementation). Phase 6 (Prisma) and Phase 9 (wiring) follow the established ingest convention of integration-only coverage — they contain no new branching logic beyond the `string⇄array` mapping already asserted via the in-memory adapter + route tests.
