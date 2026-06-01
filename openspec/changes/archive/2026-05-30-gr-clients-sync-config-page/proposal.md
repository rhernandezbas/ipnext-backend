# Proposal: Gestión Real Client Sync — Configurable Settings Page (Backend)

## Intent

Today the Gestión Real (GR) **client sync** is driven entirely by ENV vars: it runs (or not) based on `GR_SYNC_ENABLED`, on a fixed interval from `GR_SYNC_INTERVAL_MS`, scanning the estado set in `GR_SYNC_ESTADOS`. Changing any of these requires editing env and redeploying. The recently-shipped GR **installation ingest** (`gestion-real-installation-ingest`) already solved the equivalent problem: a single-row DB config (`GestionRealIngestConfig`) + a `gestion-real-ingest` runtime feature flag, editable via HTTP without a redeploy.

We want to make the GR client sync configurable the SAME way — a single-row `GestionRealSyncConfig` table for `intervalMs` + `estados`, plus a `gestion-real-sync` feature flag for the runtime on/off — exposed through HTTP endpoints. The one improvement over the ingest pattern: these endpoints are **RBAC-guarded** (the ingest routes were not). This is the BACKEND-FIRST half; a future "Sincronización" settings tab (separate FE repo) will consume these endpoints. The FE tab is a later batch and out of scope here.

## Scope

### In Scope
- New single-row Prisma model `GestionRealSyncConfig` (`id @default("singleton")`, `intervalMs Int @default(180000)`, `estados String @default("1,2,3,4,6")`, `updatedAt`).
- New domain port `GestionRealSyncConfigRepository` (`get()` / `update(patch)`) + Prisma adapter (singleton upsert) + in-memory adapter — mirroring `GestionRealIngestConfigRepository`.
- New DTO + Zod schema: `SyncConfigDTO` + `UpdateSyncConfigSchema` (partial — `intervalMs` positive int, `estados` array of allowed GR estado codes).
- New use-cases `GetSyncConfig` / `UpdateSyncConfig`. (`GetGestionRealSyncStatus` already exists and is reused.)
- New `gestion-real-sync` feature flag, seeded via an idempotent migration; the client sync use-case gates its runtime on/off on this flag (mirroring how `IngestGestionRealOrders` reads `gestion-real-ingest`).
- New RBAC-guarded HTTP endpoints:
  - `GET  /api/gestion-real/sync/config`  → `requirePerm('gestionReal', 'read')`
  - `GET  /api/gestion-real/sync/status`  → `requirePerm('gestionReal', 'read')`
  - `PUT  /api/gestion-real/sync/config`  → `requirePerm('gestionReal', 'write')`
- Bootstrap change: `bootstrapGestionRealSync` reads `intervalMs` + `estados` from the config repo (env stays as fallback default), mirroring `bootstrapGestionRealIngest`.
- Additive migrations only (new table + flag seed), timestamp later than all existing.

### Out of Scope
- The FE "Sincronización" settings tab (separate repo, follow-up batch).
- Removing the GR ENV vars. `GR_SYNC_ENABLED` / `GR_CUIT` / `GR_SECRET` stay as boot-time master gate + credentials. `GR_SYNC_INTERVAL_MS` / `GR_SYNC_ESTADOS` remain only as defaults/fallback (no longer the primary source).
- Hot-reload of interval/estados at runtime (re-read on every tick). The scheduler reads config ONCE at bootstrap, exactly like ingest. An interval change applies on next process start; the runtime flag is the live kill switch.
- Contract sync, debtor-balance batch, reconcile/reset endpoints — untouched.
- Any change to the `GetGestionRealSyncStatus` use-case or its data shape.

## Capabilities

### New Capabilities
- `gestion-real-sync-config`: stored, editable `intervalMs` + `estados` for the GR client sync, plus a runtime `gestion-real-sync` feature flag gate, exposed via RBAC-guarded config/status endpoints.

### Modified Capabilities
- `gestion-real-sync` (the existing client-sync engine): `SyncGestionRealClients` becomes flag-gated (no-op when `gestion-real-sync` is off); `bootstrapGestionRealSync` sources `intervalMs`/`estados` from the config repo instead of env.

## Approach

Replicate the `gestion-real-installation-ingest` config pattern verbatim, with two deltas: (1) the config fields are `intervalMs` + `estados` (no project FKs, so `UpdateSyncConfig` needs NO existence-validation collaborator — it's a pure partial patch), and (2) every route is wrapped in `requirePerm(...)`. The `estados` array is stored as a comma-joined `String` column (matching how the codebase already represents this exact set in env: `GR_SYNC_ESTADOS="1,2,3,4,6"`), with the DTO boundary owning the `string ⇄ string[]` mapping. The feature flag is read inside `SyncGestionRealClients.execute()` (OFF → return a zeroed/skipped result, no GR call, no SyncState write), mirroring `IngestGestionRealOrders`. The scheduler reads `intervalMs`/`estados` once at bootstrap.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` + migration | New | `GestionRealSyncConfig` single-row table |
| `prisma/migrations/` | New | Idempotent `gestion-real-sync` flag seed |
| `src/domain/ports/GestionRealSyncConfigRepository.ts` | New | `SyncConfig` type + `get()`/`update()` port |
| `src/infrastructure/adapters/prisma/PrismaGestionRealSyncConfigRepository.ts` | New | Singleton upsert adapter |
| `src/infrastructure/adapters/in-memory/InMemoryGestionRealSyncConfigRepository.ts` | New | In-memory adapter (use-case tests) |
| `src/application/dto/gestionRealSync.dto.ts` | New | `SyncConfigDTO` + `UpdateSyncConfigSchema` (+ estados ⇄ string mapping) |
| `src/application/use-cases/GetSyncConfig.ts` / `UpdateSyncConfig.ts` | New | Config read/update use-cases |
| `src/application/use-cases/SyncGestionRealClients.ts` | Modified | Add `FeatureFlagRepository` gate (`gestion-real-sync`) |
| `src/infrastructure/http/routes/gestionRealSync.routes.ts` | New | RBAC-guarded config/status router |
| `src/infrastructure/http/app.ts` | Modified | Wire one router with `requirePerm` |
| `src/infrastructure/scheduling/bootstrapGestionRealSync.ts` | Modified | Read `intervalMs`/`estados` from config repo; wire flag into sync UC |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Migrating off env breaks current prod sync | Med | New flag seeded `false` is the WRONG default for a sync that is live today — see "Migration safety" below. Seed `gestion-real-sync = true` so behavior is unchanged on deploy. Env stays as fallback default for interval/estados. |
| `SyncGestionRealClients` flag-gate accidentally no-ops a wired but un-seeded prod | Low | Flag seed migration is idempotent and ships in the same change; deploy runs `migrate deploy` before the new code path is live. |
| `app.ts` bloat (617-line God Object) | Low | Single thin router wire only; reuse existing `requirePerm` factory. |
| `estados` validation drift (codes outside 1,2,3,4,6) | Low | Zod `enum`/`refine` rejects unknown codes → 400. |
| Two GR routers both mounted under `/api/gestion-real` | Low | Mount the new sync sub-router under `/api/gestion-real/sync` (distinct prefix); existing read-only status stays at `/api/gestion-real`. |

## Migration safety (env → DB)

The GR client sync is LIVE in prod today. Two safeguards keep deploy behavior identical:
1. **Interval/estados**: the config repo `get()` returns hardcoded defaults (`intervalMs: 180000`, `estados: "1,2,3,4,6"`) before any row exists — the SAME values as the env defaults. Bootstrap still reads env as the ultimate fallback. So a fresh deploy with no config row behaves exactly as today.
2. **Runtime flag**: the `gestion-real-sync` flag is seeded **`true`** (NOT `false` like the brand-new ingest flag), because turning a currently-running sync off on deploy would be a regression. The flag becomes the live kill switch operators flip going forward.

`GR_SYNC_ENABLED` remains the boot-time master gate: false → scheduler never starts (flag irrelevant). This preserves the existing "the whole feature is off in this env" semantics.

## Rollback Plan

Flip the `gestion-real-sync` flag to `false` (or `GR_SYNC_ENABLED=false`) → sync stops, no deploy. Code rollback: revert the change branch. The new table and flag are additive; leaving them is harmless — no destructive migration to undo.

## Dependencies

- RBAC module `gestionReal` already in the catalog (`src/domain/entities/rbac.ts`); base actions `read`/`write` already valid.
- `requirePerm(module, action)` factory already exported from `app.ts`.
- `FeatureFlagRepository` + `InMemoryFeatureFlagRepository` already exist.
- `GR_SYNC_ENABLED` / `GR_CUIT` / `GR_SECRET` env (already in `config.ts`).

## Success Criteria

- [ ] `GET /sync/config` returns `{ intervalMs, estados }` DTO (estados as `string[]`), never a raw Prisma entity.
- [ ] `PUT /sync/config` updates interval/estados, validates body (400 on bad type / unknown estado code).
- [ ] All three endpoints return 403 `PERMISSION_DENIED` for a user lacking the matching `gestionReal` permission.
- [ ] `SyncGestionRealClients` is a no-op (no GR call, no SyncState write) when `gestion-real-sync` is off.
- [ ] `bootstrapGestionRealSync` builds the scheduler with `intervalMs`/`estados` from the config repo.
- [ ] Flag seeded `true`; deploy leaves current prod sync behavior unchanged.

## Open Questions

- None blocking — all decisions LOCKED in the change brief (estados as String, flag-gated in the use-case, bootstrap reads once, RBAC keys `gestionReal`/`read`+`write`).
