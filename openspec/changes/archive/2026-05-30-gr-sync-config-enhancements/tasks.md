# Tasks — gr-resync-all (Backend)

**Status**: ready
**Repo**: `ipnext-backend`
**Branch**: `feat/gr-sync-config-enhancements`
**Strict TDD**: ACTIVE — every implementation task is preceded by a failing-test task. RED → GREEN → REFACTOR.
**Test runner**: `npx jest` · **Quality gate**: `npx tsc --noEmit` · Never run `npm run build`.
**Layering**: application use cases (ports only) + infrastructure (scheduler, router, wiring). No schema/migration.
**Reuse**: `ResetGrClientsCursor`, `SyncGestionRealContracts`, `ClientMirrorReadRepository.listGrClienteIds()`,
`SyncStateRepository`, `ClientMirrorRepository.upsertContract`, `GestionRealPort.fetchContractsByClient`.
**Note**: The "Re-sincronizar todo" button UI and the estado-breakdown cards are FRONTEND tasks (paired
`ipnext-frontend` batch), NOT this list. Breakdown needs NO backend (reuse `GET /api/clients/stats`).

**Build order**: use cases first (innermost), then scheduler, then route + wiring. Each phase RED → GREEN.

---

## Phase 1 — `BackfillGrContractsBatch` use case (RED → GREEN)

- [x] 1.1 [RED] Create `src/__tests__/application/BackfillGrContractsBatch.test.ts`. Wire in-memory ports:
  `InMemoryClientMirrorReadRepository` (seed sorted ids, e.g. `['c1','c2','c3','c4','c5']`),
  `InMemoryGestionRealPort` (seed `contractsByClient`), `InMemoryClientMirrorRepository`,
  `InMemorySyncStateRepository`, wrapped in a real `new SyncGestionRealContracts(gr, mirror)`. Build
  `new BackfillGrContractsBatch(mirrorRead, syncContracts, state, /*batchSize*/ 2)`. Cases (all fail — class
  doesn't exist yet):
  - **Bounded + advances** (REQ-BACKFILL-1): arm state at `cursor:'0'`; after one `execute()`, exactly `c1,c2`
    fetched (spy `gr.fetchContractsByClient` called 2×), their contracts upserted, persisted watermark
    `cursor === '2'`, result `{ processed:2, done:false, nextOffset:2 }`.
  - **Drains then disarms** (REQ-BACKFILL-2): universe `['c1','c2','c3']`, batchSize 2 — 1st `execute()`
    → `c1,c2`, cursor `'2'`, done false; 2nd → only `c3`, cursor `null`, `done:true`; 3rd → no-op
    `{ processed:0, done:true }`, no GR calls, cursor still `null`.
  - **Not-armed no-op**: no `gr-contracts-backfill` row (or cursor null) → `execute()` returns
    `{ processed:0, done:true }`, zero GR calls.
  - **Resume after restart** (REQ-BACKFILL-3): universe `['c1','c2','c3','c4']`, batchSize 2; instance A runs
    once (→ cursor `'2'`); construct a NEW `BackfillGrContractsBatch` over the SAME `state` repo; its
    `execute()` processes exactly `c3,c4`, never re-fetches `c1,c2`.
- [x] 1.2 Run `npx jest BackfillGrContractsBatch` → RED confirmed.
- [x] 1.3 [GREEN] Create `src/application/use-cases/BackfillGrContractsBatch.ts` per design §1.3: read
  `gr-contracts-backfill` state; disarmed (no row / cursor null) → no-op `{ processed:0, done:true }`; else
  `offset = Number(cursor)`, `ids = (await mirrorRead.listGrClienteIds()).slice().sort()`; if `offset >= total`
  persist done + return done; else slice `[offset, offset+batchSize)`, `syncContracts.execute(slice)`, advance
  `nextOffset`, persist (`cursor` = `done ? null : String(nextOffset)`, `lastResult`, `itemsSynced += slice.length`),
  return `BackfillBatchResult`. `batchSize` constructor arg default 150.
- [x] 1.4 Run `npx jest BackfillGrContractsBatch` → GREEN. `npx tsc --noEmit` → clean.

## Phase 2 — `ArmGrContractsBackfill` use case (RED → GREEN)

- [x] 2.1 [RED] Create `src/__tests__/application/ArmGrContractsBackfill.test.ts` with
  `InMemorySyncStateRepository`. Cases (REQ-BACKFILL-ARM-1): arming from (a) no prior row, (b) a mid-offset
  `cursor:'7'`, (c) a done `cursor:null` → in all cases after `execute()` the persisted
  `gr-contracts-backfill` has `cursor === '0'`, `lastResult === 'armed'`, `itemsSynced === 0`; return value
  `{ armed:true, offset:0 }`.
- [x] 2.2 Run `npx jest ArmGrContractsBackfill` → RED.
- [x] 2.3 [GREEN] Create `src/application/use-cases/ArmGrContractsBackfill.ts` per design §1.4. Re-run → GREEN.

## Phase 3 — `ResyncAllGr` orchestrator (RED → GREEN)

- [x] 3.1 [RED] Create `src/__tests__/application/ResyncAllGr.test.ts` with one `InMemorySyncStateRepository`
  shared by `new ResetGrClientsCursor(state)` and `new ArmGrContractsBackfill(state)`. Seed a non-null
  `gr-clients` cursor. After `new ResyncAllGr(reset, arm).execute()`: `(await state.get('gr-clients'))?.cursor`
  is `null` AND `(await state.get('gr-contracts-backfill'))?.cursor === '0'`; return value
  `{ clients:{ entity:'gr-clients', cursor:null }, contractsBackfill:{ armed:true, offset:0 } }`. Idempotency
  case: a second `execute()` leaves both the same.
- [x] 3.2 Run `npx jest ResyncAllGr` → RED.
- [x] 3.3 [GREEN] Create `src/application/use-cases/ResyncAllGr.ts` per design §3.1 (compose `ResetGrClientsCursor`
  + `ArmGrContractsBackfill`). Re-run → GREEN. `npx tsc --noEmit` → clean.

## Phase 4 — Scheduler integration: one bounded batch per tick (RED → GREEN)

- [x] 4.1 [RED] Extend `src/__tests__/infrastructure/GestionRealSyncScheduler.test.ts`: in `makeScheduler(...)`
  also build `InMemoryClientMirrorReadRepository` + `new BackfillGrContractsBatch(read, syncContracts, state, 2)`
  and pass it as the new last `GestionRealSyncScheduler` constructor arg (signature doesn't accept it yet → RED).
  Add cases (REQ-BACKFILL-SCHED-1):
  - **One armed batch per tick**: seed mirror with several clients + `gr.contractsByClient`; arm
    `gr-contracts-backfill` at `'0'`; spy `gr.fetchContractsByClient`; one `runOnce()` → the backfill makes
    ≤ batchSize (2) calls beyond the touched set, and `summary.backfill?.processed` ≤ 2 (NOT the whole universe);
    `runOnce()` returns (no loop-to-done in one tick).
  - **No batch when disarmed**: no `gr-contracts-backfill` row → `runOnce()` makes no backfill calls;
    `summary.backfill?.processed` is 0 / undefined; lock still released (`lock.heldKeys.has('gr-sync') === false`).
- [x] 4.2 Run `npx jest GestionRealSyncScheduler` → RED.
- [x] 4.3 [GREEN] In `src/infrastructure/scheduling/GestionRealSyncScheduler.ts`: add constructor param
  `private readonly backfill?: BackfillGrContractsBatch`; in `runOnce()` after `syncContracts.execute(...)` and
  inside the `try`, add `let backfill; if (this.backfill) backfill = await this.backfill.execute();`; include
  `backfill` in `RunSummary` + the log line. Lock release stays in `finally`. Re-run → GREEN.
- [x] 4.4 `npx tsc --noEmit` → clean (confirms existing call sites still compile — `backfill` is optional).

## Phase 5 — Route: POST /resync-all + keep POST /reset (RED → GREEN)

- [x] 5.1 [RED] Extend `src/__tests__/infrastructure/http/routes/gestionRealSync.routes.test.ts`: in
  `buildApp()` add `const state = new InMemorySyncStateRepository();`,
  `const reset = new ResetGrClientsCursor(state);`, `const arm = new ArmGrContractsBackfill(state);`,
  `const resyncAll = new ResyncAllGr(reset, arm);`; pass `reset` and `resyncAll` as the new trailing args to
  `createGestionRealSyncRouter(...)`; expose `state` on the `Fixture`. (Signature mismatch → RED.) Add
  describe blocks:
  - **`POST /sync/resync-all`** (REQ-RESYNCALL-1/RBAC-1/AUTH-1): seed non-null `gr-clients` cursor;
    `writeUserId` → 200, body has `clients`, `contractsBackfill`, `message`, AND
    `(await fx.state.get('gr-clients'))?.cursor === null` AND `(await fx.state.get('gr-contracts-backfill'))?.cursor === '0'`;
    `readUserId` → 403 `{ code:'PERMISSION_DENIED', module:'gestionReal', action:'write' }` + both watermarks
    unchanged; `noPermUserId` → 403; `superAdminUserId` → 200; no cookie → 401 `{ code:'UNAUTHORIZED' }` +
    both watermarks unchanged.
  - **`POST /sync/reset`** (REQ-RESET-1): seed non-null `gr-clients` cursor + an armed `gr-contracts-backfill`;
    `writeUserId` → 200 `{ entity:'gr-clients', cursor:null }` + message; `gr-clients` cursor now null AND
    `gr-contracts-backfill` UNCHANGED (reset does not arm contracts); `readUserId` → 403.
- [x] 5.2 Run `npx jest gestionRealSync.routes` → RED.
- [x] 5.3 [GREEN] In `src/infrastructure/http/routes/gestionRealSync.routes.ts`: import `ResetGrClientsCursor`
  and `ResyncAllGr` from `@application/...`; append params `resetGrClientsCursor: ResetGrClientsCursor` and
  `resyncAllGr: ResyncAllGr`; add `POST /resync-all` and `POST /reset` routes per design §3.2 (both
  `auth → requirePerm('gestionReal','write')`); update the router JSDoc header. Re-run → GREEN.
- [x] 5.4 `npx tsc --noEmit` → clean.

## Phase 6 — Wire in app.ts + bootstrap (GREEN)

- [x] 6.1 [GREEN] In `src/infrastructure/http/app.ts` (around the `/api/gestion-real/sync` mount, ~L862):
  - `const grSyncState = new PrismaSyncStateRepository();`
  - `const resetGrClientsCursor = new ResetGrClientsCursor(grSyncState);`
  - `const armGrContractsBackfill = new ArmGrContractsBackfill(grSyncState);`
  - `const resyncAllGr = new ResyncAllGr(resetGrClientsCursor, armGrContractsBackfill);`
  - Pass `resetGrClientsCursor` + `resyncAllGr` as the new trailing args to `createGestionRealSyncRouter(...)`,
    and reuse `grSyncState` for the `GetGestionRealSyncStatus` collaborator.
  - Replace the inline `new ResetGrClientsCursor(new PrismaSyncStateRepository())` in the
    `createGrSyncRouter(...)` (`/api/admin/gr-sync`) call with the shared `resetGrClientsCursor`.
  - Add the imports for `ArmGrContractsBackfill` and `ResyncAllGr`.
- [x] 6.2 [GREEN] In `src/infrastructure/scheduling/bootstrapGestionRealSync.ts`: add
  `const mirrorRead = new PrismaClientMirrorReadRepository();` and
  `const backfill = new BackfillGrContractsBatch(mirrorRead, syncContracts, state);` (default batchSize 150);
  pass `backfill` as the new last arg to `new GestionRealSyncScheduler(...)`. Add the imports.
- [x] 6.3 `npx tsc --noEmit` → clean (verifies the only scheduler/router call sites are updated). Re-run
  `npx jest gestionRealSync.routes` + `npx jest GestionRealSyncScheduler` → GREEN.

## Phase 7 — Verify & refactor

- [x] 7.1 Run the full suite `npx jest` → green.
- [x] 7.2 [REFACTOR] Confirm: no raw Prisma entity returned from routes/use-cases; path aliases used for
  cross-layer imports; use-case files named verb+noun (`BackfillGrContractsBatch`, `ArmGrContractsBackfill`,
  `ResyncAllGr`); no `infrastructure`/Prisma import inside `application`; JSDoc updated on router + scheduler;
  legacy `/api/admin/gr-sync/reset-clients-cursor` and RBAC `/sync/reset` both still work (kept per design §4);
  backfill batch is bounded (one slice per tick, no loop).
- [x] 7.3 Confirm NO backend change for the breakdown — it reuses `GET /api/clients/stats` (design §5); the FE
  batch owns the UI + the label→field mapping.

---

## Out of scope (do NOT implement here)

- "Re-sincronizar todo" button UI + estado-breakdown cards → `ipnext-frontend` batch.
- A sync-scoped breakdown endpoint → rejected (design §5); reuse `/api/clients/stats`.
- Schema/migration changes → none; `gr-contracts-backfill` is another `SyncState` row.
- A new queue/worker for the backfill → rejected; reuse the in-process scheduler with bounded per-tick batches.
- Surfacing `batchSize` in the sync-config repo → possible future change; default 150 via constructor for now.
