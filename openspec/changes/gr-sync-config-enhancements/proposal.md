# Proposal: GR Resync-All — Resumable Contract Backfill + "Re-sincronizar todo" — Backend

> **Scope note**: This change supersedes the earlier simple-reset planning that lived in this same
> folder (`gr-sync-config-enhancements`). The previous scope (a lone RBAC `POST /sync/reset` wired to
> the existing `ResetGrClientsCursor`) is **absorbed and broadened** here under the working name
> `gr-resync-all`. The simple reset route is kept for back-compat; the new work is the resumable
> contract backfill and the "resync all" orchestrator endpoint. Branch: `feat/gr-sync-config-enhancements`.

## Intent

Today the GR mirror sync works but the **contract backfill is fragile**. The scheduler's `runOnce()`
runs `syncClients` and then `syncContracts(createdClientIds | touchedClientIds)` under the `gr-sync`
distributed lock. Two structural problems follow from that:

1. **Contracts are only fetched for clients touched THIS tick.** In a backfill, `syncContracts` receives
   only `createdClientIds` (newly-created clients); in delta, only `touchedClientIds`. Contracts of
   clients that already existed locally — or that transitioned to `baja` without a modification GR would
   surface — are **never re-fetched**. A future `gr-clients` cursor reset re-fetches clients (re-creating
   rows → re-populating `createdClientIds`) but on a *re-backfill of already-mirrored clients* `created=0`,
   so contracts are NOT re-fetched (see `GestionRealSyncScheduler.test.ts` "not re-fetched on re-backfill").
   There is no path that says "(re)sync the contracts of EVERY local client".

2. **The backfill is monolithic and non-resumable.** A full contract backfill = one `fetchContractsByClient`
   GR call per client (thousands), all inside a single `runOnce()` holding the `gr-sync` lock for 1-2h. If
   the container restarts mid-run, the work is lost and **not resumed** — the next tick starts from whatever
   `createdClientIds` it computes, which after a restart is empty for already-mirrored clients.

We need two capabilities:

1. A **resumable, batched contract backfill**: a SyncState-backed watermark over the stable, sorted list of
   local `grClienteId`s (`ClientMirrorReadRepository.listGrClienteIds()`). When "armed", each scheduler tick
   processes a BOUNDED batch (default 150 clients), fetches their contracts via the existing
   `SyncGestionRealContracts`, advances the watermark, and stops for that tick — it does **not** hold the
   lock for hours. A restart resumes from the watermark. When the watermark reaches the end, the backfill
   completes and disarms itself.

2. An RBAC-guarded **"resync all" endpoint** — `POST /api/gestion-real/sync/resync-all`
   (`gestionReal:write`) — that (a) resets the `gr-clients` cursor (reuse `ResetGrClientsCursor`, forcing a
   full client re-backfill next tick) AND (b) arms the contract-backfill watermark from the start. It
   returns a summary of both actions.

## Scope

### In Scope

- **New SyncState entity `gr-contracts-backfill`** whose `cursor` encodes backfill progress (offset into the
  stable sorted list of local `grClienteId`s — see design). No schema change: reuses the existing
  `SyncState` table (`entity` PK, `cursor`, `lastRunAt`, `lastResult`, `itemsSynced`).
- **New use case `BackfillGrContractsBatch`** (application layer, ports only): depends on
  `ClientMirrorReadRepository` (enumerate + sort local ids) + `GestionRealPort` + `ClientMirrorRepository`
  (upsert contracts, via the existing `SyncGestionRealContracts` collaborator or directly) +
  `SyncStateRepository` (read/advance the watermark). One bounded batch per `execute()`.
- **New use case `ArmGrContractsBackfill`** (application layer, ports only): writes the
  `gr-contracts-backfill` SyncState cursor to the start (offset 0, armed) so the next ticks process it.
- **New use case `ResyncAllGr`** (application layer, ports only): orchestrates `ResetGrClientsCursor` +
  `ArmGrContractsBackfill` and returns a combined summary. Composed of the other use cases (no new repo).
- **Scheduler integration**: `runOnce()` runs the existing client/delta sync, then — IF the contract
  backfill is armed — runs ONE bounded `BackfillGrContractsBatch` batch and stops. The normal
  touched-contracts sync still runs for the small delta set. Bounded so the lock is held seconds, not hours.
- **New RBAC route `POST /api/gestion-real/sync/resync-all`** on `gestionRealSync.routes.ts`,
  `auth → requirePerm('gestionReal','write')` → `ResyncAllGr.execute()` → 200 summary.
- **Keep** the existing simple reset endpoints (`POST /api/admin/gr-sync/reset-clients-cursor` auth-only and
  the previously-planned RBAC `POST /api/gestion-real/sync/reset`) for back-compat.
- **Tests**: in-memory-port unit tests for all three use cases; scheduler integration test (batch is
  bounded, watermark advances per tick, resumes after restart, disarms at end); supertest for resync-all
  (200 write, 403 read-only/no-perm, 401 no auth, arms both backfills).

### Out of Scope

- **No schema / migration change.** `gr-contracts-backfill` is just another `SyncState` row.
- **Status breakdown by estado** on the config page (Activos / Deudor / Inactivo / Incobrable / Bajas) is
  **FRONTEND-ONLY**: it reuses the existing `GET /api/clients/stats` (`{ total, active, late, inactive,
  blocked, baja }` via `GetClientStats` → `foldClientStats`). NO backend work. Noted for the FE batch.
- **Frontend** — the "Re-sincronizar todo" button UI lives in the paired `ipnext-frontend` batch; only the
  contract is noted here.
- **Changing GR's pagination of clients** or adding a contract delta feed (GR has none) — out of scope.
- **Streaming/queue infrastructure** — the batched-per-tick approach deliberately reuses the existing
  in-process scheduler; no new queue/worker.

## Capabilities

### New Capabilities

- `gr-contract-backfill`: a resumable, batched, watermark-driven backfill of the contracts of ALL local GR
  clients. Armed via the resync-all endpoint (or programmatically); advanced one bounded batch per scheduler
  tick; resumable across restarts; self-disarming at completion.

### Modified Capabilities

- `gestion-real-sync-config`: gains one RBAC-guarded operation — `POST /sync/resync-all` — alongside the
  existing `GET /config`, `PUT /config`, `GET /status` (and the back-compat `POST /sync/reset`). No
  data-shape change to the config store.

### Unchanged (reused) Capabilities

- Estado breakdown (`GET /api/clients/stats`) consumed as-is by the FE; no spec delta here.

## Approach

The contract backfill becomes a **second, independent watermark** (`gr-contracts-backfill`), processed in
**bounded batches** by the scheduler — exactly the same shape as the existing client delta, but iterating
the LOCAL client universe instead of GR's modification feed. The watermark is an **offset into the stable,
deterministically-sorted list** returned by `listGrClienteIds()` (sorted ascending so the order is stable
across ticks/restarts). Each tick: read offset → take `batchSize` ids → fetch+upsert their contracts →
advance offset → persist. When offset ≥ list length, mark done and disarm (cursor → a `"done"` sentinel /
null so it is not re-processed). A restart simply re-reads the offset.

`runOnce()` keeps its current structure (client sync → touched-contracts sync under the `gr-sync` lock) and
appends, AFTER the client sync, a single armed-backfill batch. Because the batch is bounded, the lock is
held for seconds, not hours, so other replicas still get turns and the normal delta keeps flowing.

"Resync all" is a thin orchestrator use case: reset the client cursor (full client re-backfill next tick) +
arm the contract backfill at offset 0. Both watermarks then drain incrementally over subsequent ticks.

The legacy/simple reset routes stay (idempotent, ops escape hatch).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/application/use-cases/BackfillGrContractsBatch.ts` | New | One bounded batch over the sorted local id list; advances `gr-contracts-backfill` watermark |
| `src/application/use-cases/ArmGrContractsBackfill.ts` | New | Writes `gr-contracts-backfill` cursor to offset 0 (armed) |
| `src/application/use-cases/ResyncAllGr.ts` | New | Orchestrates `ResetGrClientsCursor` + `ArmGrContractsBackfill`; returns combined summary |
| `src/infrastructure/scheduling/GestionRealSyncScheduler.ts` | Modified | After client sync, run one armed `BackfillGrContractsBatch` batch (bounded) per tick |
| `src/infrastructure/scheduling/bootstrapGestionRealSync.ts` | Modified | Construct + inject the new collaborators (read repo, backfill use case, batch size) |
| `src/infrastructure/http/routes/gestionRealSync.routes.ts` | Modified | New `POST /resync-all` route + `ResyncAllGr` constructor param |
| `src/infrastructure/http/app.ts` | Modified | Construct `ResyncAllGr` + pass into `createGestionRealSyncRouter(...)` |
| `src/domain/ports/*` | None/Reused | Reuses `SyncStateRepository`, `ClientMirrorReadRepository`, `ClientMirrorRepository`, `GestionRealPort` |
| `src/__tests__/...` | New/Modified | Use-case in-memory tests, scheduler test, resync-all supertest |
| `GET /api/clients/stats` (breakdown) | None | Reused as-is by the FE batch |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Long-running batch vs interval — a batch outlives the tick interval | Med | Bound the batch (default 150 ids ≈ 150 GR calls/tick). The `inFlight` guard already skips overlapping ticks; the next tick resumes from the watermark. Batch size is configurable. |
| Lock contention — backfill batch holds `gr-sync` and starves other replicas | Low | Bounded batch ⇒ lock held seconds, not hours. Released in `finally` (existing behavior, unchanged). |
| Idempotency of upserts on re-run | Low | `upsertContract` is keyed by `grContratoId` (existing); re-processing a batch (e.g. a crash mid-batch before the watermark advances) re-upserts harmlessly. Watermark advances only after the batch completes — at-least-once, never lost. |
| `listGrClienteIds()` order not stable across ticks → skipped/duplicated ids | Med | Sort ascending in the use case before slicing by offset. If the universe grows mid-backfill, new ids appended at the end are still covered; if it shrinks, the end offset clamps. Re-arm (resync-all) restarts cleanly. |
| **Deploy-vs-running-cron timing** — a deploy restarts the container mid-backfill | Med | The backfill is RESUMABLE (watermark persisted), so a restart continues. BUT a deploy during an in-flight batch loses only the current (un-advanced) batch, which re-runs idempotently. Operationally: prefer to deploy when no backfill is armed, or accept one batch re-run. Documented in design. |
| Two reset paths (simple reset + resync-all) confuse operators | Low | Documented: simple reset = clients only (back-compat); resync-all = clients + contracts. Both idempotent. |
| FE assumes a new breakdown endpoint | Low | Spec pins "reuse `/api/clients/stats`, no new backend". |

## Keep-vs-remove (legacy/simple reset routes)

**Decision: KEEP** both `POST /api/admin/gr-sync/reset-clients-cursor` (auth-only ops) and the RBAC
`POST /api/gestion-real/sync/reset` (clients-only). They are idempotent and useful for the narrow "just
re-backfill clients" case. `resync-all` is the broader "clients + contracts" action. (See design rationale.)

## Dependencies

- `SyncStateRepository` + `InMemorySyncStateRepository` (exist; reused for the new entity).
- `ClientMirrorReadRepository.listGrClienteIds()` + in-memory double (exist; reused to enumerate the universe).
- `ClientMirrorRepository.upsertContract` + `GestionRealPort.fetchContractsByClient` (exist; reused).
- `SyncGestionRealContracts` (exists; reusable as the per-id fetch+upsert collaborator).
- `ResetGrClientsCursor` (exists; reused by the orchestrator).
- `requirePerm('gestionReal','write')` + `createGestionRealSyncRouter` (exist; router gains one param).
- `GET /api/clients/stats` (exists; reused by FE for breakdown).

## Success Criteria

- [ ] A `BackfillGrContractsBatch.execute()` processes at most `batchSize` clients, upserts their contracts,
      and advances the `gr-contracts-backfill` watermark by the number processed.
- [ ] Two successive batches over a 3-client universe with `batchSize=2` process [c1,c2] then [c3], advancing
      the watermark to done; a third batch is a no-op (disarmed).
- [ ] After a "restart" (new use-case instance, same SyncState repo) mid-backfill, the next batch resumes
      from the persisted offset — no client is skipped or double-counted across the boundary.
- [ ] `POST /api/gestion-real/sync/resync-all` with `gestionReal:write` → 200; `gr-clients` cursor is `null`
      AND `gr-contracts-backfill` is armed at offset 0.
- [ ] Same endpoint with only `gestionReal:read` (or no perm, not super_admin) → 403 `PERMISSION_DENIED`
      `{ module:'gestionReal', action:'write' }`; neither watermark changes.
- [ ] Same endpoint with no auth cookie → 401 `UNAUTHORIZED`; neither watermark changes.
- [ ] The scheduler runs at most ONE backfill batch per tick (bounded); when disarmed it runs no batch.
- [ ] No schema/migration change. Breakdown reuses `GET /api/clients/stats` (no backend).

## Open Questions

- None blocking. Locked decisions: watermark = offset into sorted `listGrClienteIds()`; default batch
  150 (configurable); backfill runs after client sync in the same tick under the existing lock; simple
  reset routes kept; breakdown stays frontend-only.
