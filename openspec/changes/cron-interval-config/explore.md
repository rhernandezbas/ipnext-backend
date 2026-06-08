# Exploration: cron-interval-config (#30)

Make the IClass closure-loop and task-autocomplete cron intervals adjustable from the UI,
mirroring the existing GR ingest/sync config-repo pattern.

---

## Q1 — The GR config-repo pattern (template to mirror)

### Entity / Table / Port

**GR Sync** — `prisma/schema.prisma:1561-1566`
```prisma
model GestionRealSyncConfig {
  id         String   @id @default("singleton")
  intervalMs Int      @default(180000)
  estados    String   @default("1,2,3,4,6")
  updatedAt  DateTime @updatedAt
}
```
Port: `src/domain/ports/GestionRealSyncConfigRepository.ts`
```ts
interface SyncConfig { intervalMs: number; estados: string[]; }
interface GestionRealSyncConfigRepository {
  get(): Promise<SyncConfig>;          // returns DEFAULTS when no row exists
  update(patch: Partial<SyncConfig>): Promise<SyncConfig>;
}
```

**GR Ingest** — `prisma/schema.prisma:1543-1556`  (adds FK fields for fiberProjectId/wirelessProjectId)
Port: `src/domain/ports/GestionRealIngestConfigRepository.ts`
```ts
interface IngestConfig { intervalMs: number; windowMonths: number; fiberProjectId: string|null; wirelessProjectId: string|null; sourceEstado: string; }
```

### How `.get()` returns defaults

Both Prisma adapters (`PrismaGestionRealSyncConfigRepository:53-55`, `PrismaGestionRealIngestConfigRepository:50-53`):
```ts
async get(): Promise<XConfig> {
  const row = await this.table.findUnique({ where: { id: 'singleton' } });
  return row ? toConfig(row) : { ...DEFAULTS };
}
```
`DEFAULTS` is a module-level constant. No row → pure JS default, zero DB writes.

### Write path / endpoint / FE control

- **Use cases**: `GetSyncConfig` / `UpdateSyncConfig` (and `GetIngestConfig` / `UpdateIngestConfig`) — thin wrappers, one file each.
- **Routes**: `GET /api/admin/gr-sync/config` + `PUT /api/admin/gr-sync/config` (RBAC: `gestionReal:read/write`) — `src/infrastructure/http/routes/gestionRealSync.routes.ts:40-68`
- **FE control**: GR sync config has a settings panel in the GR admin section. The pattern is fully proven end-to-end.

### Bootstrap read-once pattern

`bootstrapGestionRealSync.ts:46` / `bootstrapGestionRealIngest.ts:130-132`:
```ts
const persisted = await syncConfig.get();
// ...
return new GestionRealSyncScheduler(..., { intervalMs: persisted.intervalMs }, ...);
```
`intervalMs` is read **once at startup** and passed to `new setInterval(...)`. There is **no live-reload** — if the operator updates the value, it takes effect on next server restart (or scheduler stop+start). This is the same constraint that #30 will inherit.

---

## Q2 — The two closure schedulers

### IClassClosureScheduler (`src/infrastructure/scheduling/IClassClosureScheduler.ts`)

Constructor signature:
```ts
constructor(
  ingest: IngestClosedServiceOrders,
  flags: FeatureFlagRepository,
  opts: ClosureSchedulerOptions,   // { intervalMs: number; silent?: boolean }
  lock: DistributedLock,
)
```
Bootstrap injection (`bootstrapIClassClosure.ts:43`):
```ts
return new IClassClosureScheduler(ingest, flags, { intervalMs: DEFAULT_INTERVAL_MS }, lock);
// DEFAULT_INTERVAL_MS = 10 * 60 * 1000  (line 14)
```
The scheduler calls `setInterval(() => void this.runOnce(), this.opts.intervalMs)` at `start()` — interval is **fixed at start time**.

### TaskAutocompleteScheduler (`src/infrastructure/scheduling/TaskAutocompleteScheduler.ts`)

Constructor signature:
```ts
constructor(
  reprocess: ReprocessClosureSideEffects,
  opts: TaskAutocompleteSchedulerOptions,  // { intervalMs: number; silent?: boolean }
  lock: DistributedLock,
  flags?: FeatureFlagRepository,
  manualReprocess?: ReprocessClosureSideEffects,
)
```
Bootstrap injection (`bootstrapTaskAutocomplete.ts:51`):
```ts
return new TaskAutocompleteScheduler(reprocess, { intervalMs: DEFAULT_INTERVAL_MS }, lock, flags, manualReprocess);
// DEFAULT_INTERVAL_MS = 15 * 60 * 1000  (line 15)
```
Same pattern. Interval fixed at `start()`.

### What it takes to read a persisted value at bootstrap

Both bootstrap functions are already `async` (`bootstrapIClassClosure` is currently **synchronous** — it would need to become `async` to do the DB read). Change required:

1. `bootstrapIClassClosure`: sync → async, add `PrismaIClassClosureConfigRepository`, call `.get()`, pass `persisted.intervalMs`.
2. `bootstrapTaskAutocomplete`: same.
3. Both bootstraps are called in `main.ts` — callers already use `await` for the GR ones, so the change is mechanical.

**Live-reload / re-read per tick**: Out of scope. `setInterval` is fixed at start. Changing the interval requires a restart. This matches GR's existing behavior and is acceptable.

---

## Q3 — Config storage: generic KV vs. dedicated table

### Current state

Each GR cron has its own dedicated single-row table (`GestionRealSyncConfig`, `GestionRealIngestConfig`). There is **no generic key-value config store**.

### Options

| Approach | Pros | Cons | Effort |
|----------|------|------|--------|
| **A. Two new tables** (`IClassClosureConfig` + `IClassAutocompleteConfig`) | Mirrors GR pattern exactly; typed, extensible | 2 migrations, 2 ports, 2 adapters | Medium |
| **B. One shared table** `IClassClosureConfig { closureIntervalMs, autocompleteIntervalMs }` | Single migration, single port/adapter | Slightly unusual (two concerns in one row), but perfectly valid for a singleton | Low |
| **C. Generic KV table** (e.g. `AppConfig { key, value }`) | Most flexible for future | Over-engineering; untyped values need coercion; not established in this codebase | High |

### Recommendation: Option B

A single `IClassClosureConfig` singleton table with both interval fields is the lightest path. The two crons are conceptually related (both IClass closure-loop machinery), so keeping them in one config row is reasonable. Naming: `IClassClosureConfig { id, closureIntervalMs, autocompleteIntervalMs, updatedAt }`.

Port: `IClassClosureConfigRepository { get(): Promise<IClassClosureConfig>; update(patch): Promise<IClassClosureConfig> }`.  
Defaults: `closureIntervalMs = 600000` (10 min), `autocompleteIntervalMs = 900000` (15 min).

If the two crons diverge significantly in the future, splitting is trivial (each gets its own table/port). Starting merged is the right call now.

---

## Q4 — Endpoint + FE placement

### Backend endpoint

The natural home is `iclass-closure.routes.ts` (mounted at `/api/admin/iclass`). Add:

```
GET  /closure/config        — returns IClassClosureConfig DTO
PUT  /closure/config        — updates intervalMs fields; validates with Zod
```

Guard: `requireIClassManage` (`requirePerm('iclass', 'manage')`) — already used on the reprocess and pending-count endpoints in the same router (`iclass-closure.routes.ts:101,116`).

The router factory `createIClassClosureRouter` would receive two new use cases: `GetIClassClosureConfig` + `UpdateIClassClosureConfig`.

### FE placement — coordination note with #31

The FE control (interval number inputs for closure + autocomplete) would live inside `IClassClosureFlagBody.tsx` under the existing "Cierre automático de OS" section.

**IMPORTANT**: Backlog #31 will restructure this same page ("Procesamiento/Cierre"). The interval controls for #30 should land **inside #31's restructured layout**, not bolted onto the current `IClassClosureFlagBody`. #30 should be planned as: BE fully self-contained, FE widget lands in #31's page restructure (or as a follow-up PR after #31 merges).

If #30 ships before #31: add the interval inputs to the existing `IClassClosureFlagBody` in a way that is easy to move. If #31 ships first: the new page structure provides the natural slot.

---

## Q5 — Tests

### Existing config-repo tests to mirror

- `src/__tests__/application/gestion-real-sync/GetSyncConfig.test.ts` — use case test with InMemory repo
- `src/__tests__/application/gestion-real-sync/UpdateSyncConfig.test.ts` — partial patch + defaults
- `src/__tests__/infrastructure/adapters/in-memory/InMemoryGestionRealSyncConfigRepository.test.ts` — in-memory adapter contract

New tests to write (strict TDD — test first):
1. `GetIClassClosureConfig.test.ts` — returns defaults when no row, returns persisted values
2. `UpdateIClassClosureConfig.test.ts` — partial patch (only closureIntervalMs, only autocompleteIntervalMs, both)
3. `InMemoryIClassClosureConfigRepository.test.ts` — in-memory adapter contract
4. Scheduler bootstrap integration — `bootstrapIClassClosure` / `bootstrapTaskAutocomplete` tests are light (they test the full wiring); the key invariant is that the scheduler receives the DB-persisted interval, not the hardcoded default. Can be verified via the scheduler's `opts.intervalMs` after construction.

### Existing scheduler tests to extend

- `src/__tests__/infrastructure/IClassClosureScheduler.test.ts` — already tests runOnce/flag/lock. No changes needed (interval is an opts input, already tested via `{ intervalMs: 1000 }`).
- `src/__tests__/infrastructure/TaskAutocompleteScheduler.test.ts` — same; no changes needed.

---

## Current State

```
src/infrastructure/scheduling/
  bootstrapIClassClosure.ts          # sync, DEFAULT_INTERVAL_MS hardcoded (line 14)
  bootstrapTaskAutocomplete.ts       # sync, DEFAULT_INTERVAL_MS hardcoded (line 15)
  IClassClosureScheduler.ts          # intervalMs via opts, setInterval fixed at start()
  TaskAutocompleteScheduler.ts       # intervalMs via opts, setInterval fixed at start()

src/infrastructure/http/routes/
  iclass-closure.routes.ts           # GET/POST/PATCH closure endpoints — no config endpoint yet
```

No `IClassClosureConfig` table, port, or adapter exists. No GET/PUT `/closure/config` endpoint. No FE interval controls.

---

## Affected Areas

- `prisma/schema.prisma` — add `IClassClosureConfig` model (1 migration)
- `src/domain/ports/IClassClosureConfigRepository.ts` — new port (interface)
- `src/infrastructure/adapters/prisma/PrismaIClassClosureConfigRepository.ts` — new adapter
- `src/infrastructure/adapters/in-memory/InMemoryIClassClosureConfigRepository.ts` — new in-memory adapter
- `src/application/use-cases/GetIClassClosureConfig.ts` — new use case
- `src/application/use-cases/UpdateIClassClosureConfig.ts` — new use case
- `src/application/dto/iclassClosure.dto.ts` — add config DTO + Zod schema
- `src/infrastructure/scheduling/bootstrapIClassClosure.ts` — sync → async, read config
- `src/infrastructure/scheduling/bootstrapTaskAutocomplete.ts` — sync → async, read config
- `src/infrastructure/http/routes/iclass-closure.routes.ts` — add GET/PUT /closure/config
- `src/infrastructure/http/app.ts` — wire new use cases into createIClassClosureRouter
- `src/main.ts` — await on the now-async bootstraps (if not already awaited)
- FE: `src/pages/scheduling/settings/IClassClosureFlagBody.tsx` (or #31's restructured page)
- FE: `src/api/iclassClosure.api.ts` — add getClosureConfig / updateClosureConfig calls

---

## Approaches

1. **Two separate config tables** (mirror GR exactly) — Extra migration/port/adapter per cron. More isolated. Medium effort.
   - Pros: Exact GR pattern, each cron fully independent
   - Cons: 2x boilerplate for a small feature
   - Effort: Medium

2. **One shared `IClassClosureConfig` table** (recommended) — Both intervals in one singleton row.
   - Pros: Single migration, single port/adapter, minimal boilerplate, easy to split later
   - Cons: Slightly mixes two concerns in one entity (acceptable for a singleton config)
   - Effort: Low

3. **Generic KV store** — Not established; overkill.
   - Effort: High

---

## Recommendation

**Option B** (one shared `IClassClosureConfig` table). It is the lightest path, consistent with the singleton pattern already used by GR, and the two fields are closely related operationally. Splitting can happen later if these crons diverge in complexity.

Bootstrap functions become `async` — a mechanical change. The interval is read once at startup (no live-reload), matching GR behavior.

FE interval controls should land in #31's page restructure to avoid double-touch on `IClassClosureFlagBody`. Coordinate: #30 BE first, FE as part of #31 (or immediately after).

---

## Risks

### CRITICAL: bootstrapTaskAutocomplete async + createApp injection conflict
`main.ts:21` calls `bootstrapTaskAutocomplete()` synchronously BEFORE `createApp(taskAutocomplete)` because the scheduler must be injected into the iclass-closure router. If `bootstrapTaskAutocomplete` becomes `async`, `createApp` can no longer receive the scheduler synchronously.

**Resolution options**:
- A. Read the config inside `createApp` itself (pass a `PrismaIClassClosureConfigRepository` to `createApp` and resolve the interval there, async). This keeps the bootstrap sync but moves config reading to app startup.
- B. Restructure `main.ts` to wrap everything in an `async` IIFE (like Express best practice). Then `const taskAutocomplete = await bootstrapTaskAutocomplete()` followed by `createApp(taskAutocomplete)` is trivial.
- C. Have `bootstrapTaskAutocomplete` remain sync but accept an already-resolved `intervalMs` as a parameter. The caller in `main.ts` reads config first, passes it in.

**Recommended**: Option B (async IIFE in main.ts) — clean, idiomatic, matches what GR bootstraps already do (they just use `void bootstrap().then()`). It unblocks both IClass bootstraps being async without touching the scheduler class signatures.

### Other risks
- The `(prisma as any).iclassClosureConfig` accessor pattern (used in GR adapters due to the locally-regenerated client) must be followed until Prisma client is regenerated.
- #30 FE and #31 page restructure may conflict if developed in parallel — coordinate branch order.
- `setInterval` is fixed at start; operators must restart the server after changing the interval. This should be clearly communicated in the UI (a tooltip or description note).

---

## Ready for Proposal

Yes. The pattern is fully understood, the template (GR sync/ingest) is battle-tested, and the lightest path (Option B) is clear. Ready to proceed to `sdd-propose`.
