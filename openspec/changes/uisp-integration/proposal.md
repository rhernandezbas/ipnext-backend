# Proposal: UISP Integration (V1) — Node Mirror

## Intent

Operators need to see network nodes and equipment (73 sites, 4009 devices) from UISP inside our panel. UISP is THE source of truth for nodes — independent of IClass/NetworkSite. A live probe measured `/devices` at **5.17s** (full) and **2.51s** (small site): unacceptable for page-loads, ideal for background. V1 builds an owned **mirror** (`UispSite` + `UispDevice`) synced every 5 min, so reads hit our DB. The `deviceId→siteId` mirror is the hook for V2 (1:1 service↔device auto-move).

## Scope

### In Scope
- Prisma tables `UispSite` + `UispDevice` (owned catalog, NOT NetworkSite/IClass).
- `UispClient` adapter (axios, `x-auth-token`, self-signed TLS `rejectUnauthorized:false`).
- `SyncUisp` use case: full upsert by `uispId`, soft-missing via `missingSince`.
- `UispSyncScheduler` (advisory lock + flag gate, 5-min interval; mirrors TaskAutocompleteScheduler).
- Feature flag `uisp-sync` (default OFF, seeded in migration) gating the cron.
- New RBAC module `uisp`: `uisp:read`, `uisp:manage`; granted to super_admin.
- Read endpoints (list sites, site detail+devices, sync status) + manual `sync now`.
- Config `config.uisp` (env `UISP_BASE_URL` + `UISP_TOKEN`, opt-in — NO fail-fast).

### Out of Scope
- All of V2: service↔device association, client tab, signal/outage history, sync logs.
- Touching NetworkSite / IClass; `/outages` history endpoint; UISP write-back; webhooks.
- FE detail: a separate `/api/network-sites` CRUD lacks `requirePermission` — **tracked as debt**, fixed separately.

## Capabilities

### New Capabilities
- `uisp-mirror`: owned `UispSite`/`UispDevice` schema + full-upsert sync semantics (soft-missing).
- `uisp-sync-scheduler`: 5-min cron gated by `uisp-sync` flag + advisory lock; manual trigger.
- `uisp-read-api`: list sites, site detail + devices, sync status endpoints.
- `uisp-rbac`: new `uisp` module + `read`/`manage` permissions + super_admin grant.

### Modified Capabilities
- None.

## Approach

ESPEJO, not live-proxy. `UispSyncScheduler` runs every 5 min: if `uisp-sync` flag OFF or env missing → skip with log. Otherwise acquire advisory lock, pull `/sites` + `/devices`, full-upsert by `uispId`, stamp `missingSince` on vanished rows (no hard delete). All HTTP reads serve from the mirror. Migration mirrors `20260618000000_rbac_admin_flags_permission`: new module + permissions + grant + flag seed.

**Wire contract (high-level):**
| Method | Path | Perm |
|--------|------|------|
| GET | `/api/uisp/sites` | `uisp:read` |
| GET | `/api/uisp/sites/:uispId` (detail + devices) | `uisp:read` |
| GET | `/api/uisp/sync/status` | `uisp:read` |
| POST | `/api/uisp/sync` (sync now) | `uisp:manage` |

`status:"unknown"` on a site = normal polling state, NOT a warning (FE must not flag it). Devices include all types (ap/station/router) with `type`/`role` columns.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | New | `UispSite`, `UispDevice` models |
| `prisma/migrations/` | New | tables + RBAC `uisp` module/perms + `uisp-sync` flag seed |
| `src/domain/entities/uisp.ts` + `errors/uisp.ts` | New | entities + typed errors |
| `src/domain/ports/UispClient.ts`, `UispSiteRepository.ts`, `UispDeviceRepository.ts` | New | ports |
| `src/application/use-cases/SyncUisp.ts` + list/detail/status use cases | New | mirror logic |
| `src/infrastructure/adapters/uisp/UispClient.ts` + prisma/in-memory repos | New | adapters |
| `src/infrastructure/scheduling/UispSyncScheduler.ts` | New | cron |
| `src/infrastructure/http/routes/uisp.routes.ts` | New | endpoints |
| `src/infrastructure/config.ts`, `http/app.ts` | Modified | config block + DI wiring |
| `src/domain/entities/rbac.ts` | Modified | `uisp` module + `read`/`manage` in KNOWN_ACTIONS |
| `.github/workflows/deploy.yml` | Modified | forward `UISP_BASE_URL`/`UISP_TOKEN` secrets |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| UISP env missing | Med | Opt-in: skip sync + log; UI shows "no configurado". No fail-fast. |
| Self-signed TLS (`rejectUnauthorized:false`) | High | Internal IP only; DOCUMENTED in adapter. Never for public endpoints. |
| Sync overlap / double-run | Med | Advisory lock + `inFlight` flag (TaskAutocompleteScheduler pattern). |
| Stale mirror if UISP down | Med | `lastSyncAt` surfaced in UI; reads degrade gracefully (last good data). |
| Hard-delete loses re-appearing devices | Low | Soft `missingSince` timestamp, not delete. |
| RBAC action/migration drift | Med | Add to KNOWN_ACTIONS AND migration together (fail-closed otherwise). |

## Rollback Plan

Set `uisp-sync` flag OFF → cron dormant, mirror frozen, reads still work on last data. To fully revert: down-migration drops `UispSite`/`UispDevice` + `uisp` RBAC rows + flag; remove routes/wiring. No NetworkSite/IClass data touched, so rollback is isolated.

## Dependencies

- Env secrets `UISP_BASE_URL` + `UISP_TOKEN` (GitHub secrets + deploy.yml forwarding — GR/IClass pattern). Optional: absence = graceful skip.

## Success Criteria

- [ ] With flag ON + env set, mirror populates 73 sites / 4009 devices within one cron cycle.
- [ ] `GET /api/uisp/sites` and `/:uispId` serve from DB (no live UISP call on page-load).
- [ ] `uisp:read`/`uisp:manage` enforced; super_admin granted via migration.
- [ ] Flag OFF or env missing → sync skipped with log; UI shows "no configurado".
- [ ] Device that moves nodes in UISP updates its `uispSiteId` on next sync (V2 hook).
