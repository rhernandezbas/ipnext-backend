# Design — gr-resync-all (Backend)

**Repo**: `ipnext-backend`
**Branch**: `feat/gr-sync-config-enhancements`
**Scope**: A resumable, batched **contract backfill** (`gr-contracts-backfill` watermark) driven one bounded
batch per scheduler tick, plus an RBAC-guarded **`POST /sync/resync-all`** that resets the client cursor and
arms the contract backfill. Three new application use cases (ports only); scheduler + bootstrap + router +
`app.ts` wiring. No schema/migration. The clients-only `POST /sync/reset` and the legacy auth-only ops route
are KEPT. Breakdown = reuse `GET /api/clients/stats` (no backend).

---

## 1. The resumable contract-backfill watermark

### 1.1 Why a second watermark (not a tweak to `runOnce`)

The existing contract sync is **owner-driven**: `syncContracts(touched|createdClientIds)` follows whatever
the client sync touched that tick. That is correct for steady-state delta but structurally cannot express
"(re)sync contracts of EVERY local client" — and a full pass crammed into one `runOnce()` would hold the
`gr-sync` lock for 1-2h and be lost on restart. So we add a **separate, persisted, resumable cursor** that
iterates the LOCAL client universe independently of GR's modification feed.

### 1.2 Watermark scheme — offset into the sorted local id list

The backfill state is a row in the existing `SyncState` table, `entity = "gr-contracts-backfill"`. We reuse
the existing columns — **no schema change**:

| Column        | Meaning for `gr-contracts-backfill`                                              |
|---------------|---------------------------------------------------------------------------------|
| `cursor`      | The progress encoding (see below). `null` = disarmed/done.                      |
| `lastRunAt`   | Timestamp of the last batch.                                                    |
| `lastResult`  | `"armed"`, `"batch ok @<offset>"`, `"done"`, or `"error: …"`.                    |
| `itemsSynced` | Cumulative clients processed in the current armed run (reset to 0 on arm).      |

**Cursor encoding — offset (integer-as-string):** the `cursor` holds the **offset** into the
deterministically-sorted list returned by `ClientMirrorReadRepository.listGrClienteIds()`. `cursor = "0"`
when armed; advances by the number of ids processed each batch; when it reaches/exceeds `total` the backfill
is **done** and we write `cursor = null`, `lastResult = "done"` (disarmed).

**Why offset, not last-processed-id:** an offset into a *stably sorted* list (ascending) gives O(1) "where am
I", needs no extra index, and survives restart by simply re-reading the offset. The list is sorted IN THE USE
CASE (`[...ids].sort()`) so order is deterministic regardless of repo/DB ordering — the spec's "no client
skipped or double-counted" guarantee rests on this sort being stable.

**Universe-changes-mid-backfill semantics** (documented, accepted):
- Universe GROWS (new clients appended after sort): new ids land at the END (ascending sort), so they fall at
  higher offsets and ARE covered before we reach the end. Good.
- Universe SHRINKS (clients removed): the list is shorter; the end check `offset >= total` clamps, so we stop
  at the new end. A removed id below the current offset was already processed; one above is simply gone. No
  crash, no infinite loop.
- A `resync-all` re-arm resets offset → 0, giving a clean full pass. This is the operator's "I want it
  exactly right" button.

### 1.3 `BackfillGrContractsBatch` use case (application, ports only)

```ts
// src/application/use-cases/BackfillGrContractsBatch.ts (NEW)
export interface BackfillBatchResult {
  processed: number;   // ids handled this batch (≤ batchSize)
  fetched: number;     // contracts fetched
  created: number;
  updated: number;
  nextOffset: number;  // persisted watermark offset after this batch
  done: boolean;       // true when the universe is fully covered (disarmed)
}

export class BackfillGrContractsBatch {
  constructor(
    private readonly mirrorRead: ClientMirrorReadRepository,   // listGrClienteIds()
    private readonly syncContracts: SyncGestionRealContracts,  // reuse: fetch+upsert per id
    private readonly state: SyncStateRepository,
    private readonly batchSize = 150,
  ) {}

  async execute(): Promise<BackfillBatchResult> {
    const prior = await this.state.get('gr-contracts-backfill');
    if (!prior || prior.cursor === null) {
      return { processed: 0, fetched: 0, created: 0, updated: 0, nextOffset: 0, done: true }; // disarmed
    }
    const offset = Number(prior.cursor) || 0;
    const ids = (await this.mirrorRead.listGrClienteIds()).slice().sort(); // deterministic
    const total = ids.length;
    if (offset >= total) { /* persist done (cursor:null, lastResult:'done') */ return {…, done:true}; }

    const slice = ids.slice(offset, offset + this.batchSize);
    const r = await this.syncContracts.execute(slice);   // existing per-id fetch+upsert
    const nextOffset = offset + slice.length;
    const done = nextOffset >= total;
    await this.state.save({
      entity: 'gr-contracts-backfill',
      cursor: done ? null : String(nextOffset),
      lastRunAt: new Date(),
      lastResult: done ? 'done' : `batch ok @${nextOffset}`,
      itemsSynced: (prior.itemsSynced ?? 0) + slice.length,
    });
    return { processed: slice.length, fetched: r.fetched, created: r.created, updated: r.updated, nextOffset, done };
  }
}
```

- **Bounded**: it slices at most `batchSize` ids, makes ≤ `batchSize` GR `fetchContractsByClient` calls, and
  returns. No internal loop-to-completion.
- **Resumable**: all progress is in `SyncState`; a fresh instance over the same repo reads the same offset.
- **Idempotent / at-least-once**: the watermark advances only AFTER the batch's upserts complete. A crash
  mid-batch (before the `save`) re-runs that batch next time — `upsertContract` (keyed by `grContratoId`) is
  idempotent, so re-processing is harmless; nothing is lost.
- **Reuses `SyncGestionRealContracts`** as the per-id fetch+upsert collaborator — no duplicated GR/upsert
  logic. (Alternatively the use case could call `gr.fetchContractsByClient` + `mirror.upsertContract`
  directly; reusing `syncContracts` is preferred to keep one contract-fetch path.)

`batchSize` is a constructor arg (default **150**) so tests inject a tiny size and bootstrap can override.

### 1.4 `ArmGrContractsBackfill` use case (application, ports only)

```ts
// src/application/use-cases/ArmGrContractsBackfill.ts (NEW)
export class ArmGrContractsBackfill {
  constructor(private readonly state: SyncStateRepository) {}
  async execute(): Promise<{ armed: true; offset: 0 }> {
    await this.state.save({
      entity: 'gr-contracts-backfill',
      cursor: '0',                       // armed at start
      lastRunAt: null,
      lastResult: 'armed',
      itemsSynced: 0,
    });
    return { armed: true, offset: 0 };
  }
}
```

Idempotent: arming over any prior state lands at offset 0.

---

## 2. Scheduler integration — one bounded batch per tick, after client sync

`GestionRealSyncScheduler` gains ONE optional collaborator, `backfill?: BackfillGrContractsBatch`, injected
via the constructor (keeps it null-safe: when GR is configured we pass it; tests pass it when exercising the
backfill). `runOnce()` keeps its exact current shape and appends a single batch AFTER the touched-contracts
sync, still inside the `try` (so errors are swallowed) and BEFORE the `finally` (so the lock releases):

```ts
this.inFlight = true;
try {
  const clients = await this.syncClients.execute();
  const contractIds = clients.mode === 'backfill' ? clients.createdClientIds : clients.touchedClientIds;
  const contracts = await this.syncContracts.execute(contractIds);

  // NEW: drain ONE bounded contract-backfill batch if armed. Bounded ⇒ lock held seconds, not hours.
  let backfill: BackfillBatchResult | undefined;
  if (this.backfill) backfill = await this.backfill.execute();   // no-op when disarmed

  this.log(`[gr-sync] ${clients.mode}: clients +${clients.created}/~${clients.updated}, ` +
           `contracts +${contracts.created}/~${contracts.updated}` +
           (backfill && backfill.processed ? `, backfill ${backfill.processed} (@${backfill.nextOffset}${backfill.done ? ' done' : ''})` : ''));
  return { clients, contracts, backfill };
} catch (err) { … } finally { this.inFlight = false; await this.lock.release(LOCK_KEY); }
```

`RunSummary` gains an optional `backfill?: BackfillBatchResult`.

**Decisions:**
- **Same tick, after client sync** (not a separate independent timer like the balance batch). Rationale: it
  reuses the existing `gr-sync` lock + `inFlight` guard so the backfill never overlaps the client sync or
  another replica's batch — no new lock to reason about. The balance batch is independent because it touches
  a different table and can race the sync harmlessly; the contract backfill writes Services and benefits from
  serialization with the client sync that owns those rows.
- **One batch per tick** (no loop). This is the whole point: a bounded slice keeps the lock held for seconds.
  A 5000-client universe at `batchSize=150` drains in ~34 ticks; at a 3-min interval that's ~1.7h of
  background draining — but each tick is short, the lock frees between batches, and a restart resumes.
- **Default `batchSize = 150`.** ~150 sequential GR calls per tick is well under a 3-minute interval (the
  default `intervalMs`) even at a few hundred ms/call, leaving headroom for the client sync in the same tick.
  Configurable via the use-case constructor; can later be surfaced in the sync-config repo if needed (not in
  this change).

---

## 3. `ResyncAllGr` orchestrator + the `resync-all` route

### 3.1 `ResyncAllGr` use case (application, composes existing use cases)

```ts
// src/application/use-cases/ResyncAllGr.ts (NEW)
export class ResyncAllGr {
  constructor(
    private readonly resetClients: ResetGrClientsCursor,
    private readonly armBackfill: ArmGrContractsBackfill,
  ) {}
  async execute() {
    const clients = await this.resetClients.execute();          // { entity:'gr-clients', cursor:null }
    const contractsBackfill = await this.armBackfill.execute();  // { armed:true, offset:0 }
    return { clients, contractsBackfill };
  }
}
```

Pure composition of two existing/new use cases — no new repository, no infrastructure import. DIP intact.

### 3.2 Route — `createGestionRealSyncRouter` gains ONE param

The router currently takes 5 params. We add `resyncAllGr: ResyncAllGr` (and, per the kept clients-only reset,
`resetGrClientsCursor: ResetGrClientsCursor`) appended after the existing collaborators:

```ts
export function createGestionRealSyncRouter(
  authProvider, requirePerm, getSyncConfig, updateSyncConfig, getSyncStatus,
  resetGrClientsCursor: ResetGrClientsCursor,   // ← kept (clients-only /reset)
  resyncAllGr: ResyncAllGr,                     // ← new (/resync-all)
): Router

router.post('/resync-all', auth, requirePerm('gestionReal','write'),
  async (_req, res, next) => {
    try {
      const result = await resyncAllGr.execute();
      res.json({ ...result, message: 'next ticks will re-backfill all clients and their contracts' });
    } catch (err) { next(err); }
  });

router.post('/reset', auth, requirePerm('gestionReal','write'),
  async (_req, res, next) => {
    try {
      const result = await resetGrClientsCursor.execute();
      res.json({ ...result, message: 'next sync will backfill all clients' });
    } catch (err) { next(err); }
  });
```

Middleware order `auth → requirePerm('gestionReal','write') → handler` (identical to `PUT /config`): no-auth
→ 401 before the perm check; missing perm → 403; `super_admin` short-circuits in `requirePerm`.

### 3.3 Wiring in `app.ts`

`app.ts` already builds `new ResetGrClientsCursor(new PrismaSyncStateRepository())` for `/api/admin/gr-sync`.
**Hoist it to a shared `const`**, build the backfill arm + orchestrator off the SAME `PrismaSyncStateRepository`,
and pass them into the sync router:

```ts
const grSyncState = new PrismaSyncStateRepository();
const resetGrClientsCursor = new ResetGrClientsCursor(grSyncState);
const armGrContractsBackfill = new ArmGrContractsBackfill(grSyncState);
const resyncAllGr = new ResyncAllGr(resetGrClientsCursor, armGrContractsBackfill);

app.use('/api/gestion-real/sync', createGestionRealSyncRouter(
  authAdapter, requirePerm,
  new GetSyncConfig(grSyncConfigRepo), new UpdateSyncConfig(grSyncConfigRepo),
  new GetGestionRealSyncStatus(grSyncState, new PrismaMirrorCountsRepository()),
  resetGrClientsCursor,   // shared
  resyncAllGr,            // new
));
app.use('/api/admin/gr-sync', createGrSyncRouter(authAdapter, resetGrClientsCursor, reconcileGrClients)); // same instance
```

### 3.4 Scheduler wiring in `bootstrapGestionRealSync.ts`

The bootstrap already builds `client`, `mirror` (Prisma `ClientMirrorRepository`), `state`, `syncContracts`.
Add the read repo + the batch use case and inject into the scheduler:

```ts
const mirrorRead = new PrismaClientMirrorReadRepository();        // listGrClienteIds()
const backfill = new BackfillGrContractsBatch(mirrorRead, syncContracts, state /*, batchSize default 150*/);
const scheduler = new GestionRealSyncScheduler(syncClients, syncContracts, { intervalMs: persisted.intervalMs }, lock, backfill);
```

`PrismaClientMirrorReadRepository` and `PrismaSyncStateRepository` already exist; the only new construction is
`BackfillGrContractsBatch` and the extra scheduler arg.

---

## 4. Keep-vs-remove the legacy/simple reset routes — DECISION: KEEP

- `POST /api/admin/gr-sync/reset-clients-cursor` (auth-only ops): KEEP. Ops/curl escape hatch; idempotent;
  removing it breaks runbooks for no benefit.
- `POST /api/gestion-real/sync/reset` (RBAC, clients-only): KEEP. The narrow "just re-backfill clients" path.
  `resync-all` is the broader "clients + contracts" action; having both lets an operator pick the cheaper one
  when contracts don't need re-syncing. All three call shared, idempotent use-case instances — no drift.

---

## 5. Status breakdown by estado — DECISION: REUSE `/api/clients/stats`, NO backend

Unchanged from the prior scope. `GET /api/clients/stats` → `GetClientStats` → `foldClientStats` already
returns `{ total, active, inactive, blocked, late, baja }` — exactly the five buckets the page needs. The FE
consumes it in `ClientStatsCards`. Label → field mapping: Activos→`active`, Deudor→`late`,
Inactivo→`inactive`, Incobrable→`blocked`, Bajas→`baja`. **No new backend endpoint** — a sync-scoped
breakdown endpoint is rejected (it would duplicate `foldClientStats` behind another permission and risk
drift). Breakdown is FRONTEND-ONLY.

---

## 6. Deploy-vs-running-cron timing (operational risk)

The in-process scheduler runs in the API container. A deploy restarts the container, killing whatever batch
is in flight. Because the backfill is **resumable** (offset persisted in `SyncState`), a restart simply
resumes from the last persisted offset — at most the **current un-advanced batch re-runs**, which is
idempotent (upserts keyed by `grContratoId`). Concretely:

- Safe to deploy at any time: nothing is permanently lost; the backfill continues after restart.
- The one cost is a single re-run of the in-flight batch's ≤150 contract fetches — negligible.
- Operational recommendation: if a large `resync-all` was just armed, either let the backfill settle or
  accept one batch re-run; do NOT assume a deploy "cancels" an armed backfill — it does not, it resumes.
- This is strictly better than today, where a restart mid-`runOnce` lost the entire monolithic contract pass
  with no resume.

---

## 7. Testing strategy (Strict TDD)

Test runner `npx jest`; quality gate `npx tsc --noEmit`; never `npm run build`. In-memory ports only for
use-case tests (no Prisma mocks).

- **`BackfillGrContractsBatch`** (`src/__tests__/application/`): `InMemoryClientMirrorReadRepository` (seeded
  sorted ids) + `InMemoryGestionRealPort` (seeded `contractsByClient`) + `InMemoryClientMirrorRepository` +
  `InMemorySyncStateRepository`, wrapped in a real `SyncGestionRealContracts`. Cover: bounded batch advances
  watermark (REQ-BACKFILL-1); drains in N batches then disarms (REQ-BACKFILL-2); not-armed no-op; **resume
  after restart** = construct a NEW `BackfillGrContractsBatch` over the SAME `InMemorySyncStateRepository` and
  assert it continues from the offset (REQ-BACKFILL-3).
- **`ArmGrContractsBackfill`** (`src/__tests__/application/`): arming from any prior state lands at offset 0
  (REQ-BACKFILL-ARM-1).
- **`ResyncAllGr`** (`src/__tests__/application/`): over one `InMemorySyncStateRepository`, asserts
  `gr-clients` cursor → null AND `gr-contracts-backfill` armed at "0".
- **Scheduler** (extend `GestionRealSyncScheduler.test.ts`): inject a `BackfillGrContractsBatch`; assert ONE
  bounded batch per `runOnce()` (spy `fetchContractsByClient` call count ≤ batchSize beyond the touched set);
  assert NO backfill batch when disarmed; lock still released (REQ-BACKFILL-SCHED-1).
- **Route** (extend `gestionRealSync.routes.test.ts`): wire `InMemorySyncStateRepository` +
  `ResetGrClientsCursor` + `ArmGrContractsBackfill` + `ResyncAllGr` into `buildApp()`, pass the new router
  args. Cover `resync-all`: 200 write + both watermarks set (cursor null, backfill "0"), 403 read-only,
  403 no-perm, 200 super_admin, 401 no cookie; and `reset`: 200 clears only the client cursor (backfill
  untouched), 403 read-only.

---

## 8. Layering & conventions check

- New code lives in `application/use-cases/` (ports only) + `infrastructure/scheduling|http` — DIP intact;
  no `domain`/`application` imports of `infrastructure` or Prisma.
- Use-case naming verb+noun, one per file: `BackfillGrContractsBatch.ts`, `ArmGrContractsBackfill.ts`,
  `ResyncAllGr.ts`.
- Router stays decoupled via constructor injection (no app-singleton imports); responses are plain
  DTO-shaped objects, never raw Prisma entities.
- No new port, no schema, no migration — `gr-contracts-backfill` is another `SyncState` row.
- Path aliases (`@application/...`, `@domain/...`) for cross-layer imports.
