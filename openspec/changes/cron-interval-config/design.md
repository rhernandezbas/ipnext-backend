# Design: Configurable Cron Intervals for IClass Closure & Autocomplete (#30)

## Technical Approach

Mirror the proven GR config-repo pattern (Option B from exploration): one shared `IClassClosureConfig`
singleton table, one port (`get`/`update`), Prisma + InMemory adapters, two thin use cases, and a
GET/PUT `/closure/config` endpoint on the existing iclass-closure router. Both bootstraps read the
persisted intervals once at startup and inject them via `opts.intervalMs`. The only non-mechanical
change is `main.ts`: `bootstrapIClassClosure` goes sync→async and `bootstrapTaskAutocomplete` must
`await` before `createApp(taskAutocomplete)`, so startup is wrapped in an async IIFE.

## Architecture Decisions

| Decision | Choice | Alternatives rejected | Rationale |
|----------|--------|-----------------------|-----------|
| main.ts ordering | Async IIFE; read config once, await both bootstraps before `createApp` | top-level await; read config inside `createApp`; pass intervalMs as sync param | `module: CommonJS` (tsconfig) → no top-level await. IIFE keeps the read-once contract and matches GR `void bootstrap().then()` idiom. |
| Config storage | One shared singleton table `IClassClosureConfig` | two tables; generic KV | Lightest path; two related crons; trivial to split later. Matches GR singleton. |
| Defaults source | Module-level `DEFAULTS` in adapters; `get()` returns them when no row | seed a row in migration | Zero DB writes on first read — exact GR contract. |
| Prisma accessor | `(prisma as any).iClassClosureConfig` | regen client now | Matches GR adapters; survives un-regenerated local client. |
| Config read site | main.ts reads repo ONCE, passes resolved config into each bootstrap | each bootstrap reads the repo | One DB read at startup; both bootstraps stay pure injection. |

## Data Flow

```
main.ts (async IIFE)
  └─ configRepo.get()  ──┐ (read ONCE)
        │                │
        ├─ bootstrapIClassClosure(cfg.closureIntervalMs)      → IClassClosureScheduler{opts.intervalMs}
        ├─ await bootstrapTaskAutocomplete(cfg.autocompleteIntervalMs) → TaskAutocompleteScheduler{opts.intervalMs}
        ├─ createApp(taskAutocomplete)   (needs scheduler instance, sync after await)
        └─ app.listen(...)

PUT /closure/config → UpdateIClassClosureConfig → configRepo.update(patch)  [persisted, NO live reload]
GET /closure/config → GetIClassClosureConfig → configRepo.get() → DTO
```

## main.ts — Before / After (the critical bit)

**Before** (sync): `const taskAutocomplete = bootstrapTaskAutocomplete();` then `createApp(taskAutocomplete)` then `app.listen`. GR bootstraps fire-and-forget after listen. Nothing else depends on a sync bootstrap (verified: `iclassClosure?.start()` and `taskAutocomplete?.start()` run after listen).

**After** (async IIFE):
```ts
void (async () => {
  const configRepo = new PrismaIClassClosureConfigRepository();
  const cfg = await configRepo.get();                                  // (a) read ONCE

  const iclassClosure = await bootstrapIClassClosure(cfg.closureIntervalMs);        // (b) now async
  const taskAutocomplete = await bootstrapTaskAutocomplete(cfg.autocompleteIntervalMs); // (c)

  const app = createApp(taskAutocomplete);                             // (d) sync, post-await
  app.listen(config.port, () => console.log(`[server] Running on port ${config.port}`));

  void bootstrapGestionRealSync().then((s) => s?.start()).catch(/* kept alive */);
  void bootstrapGestionRealIngest().then((s) => s?.start()).catch(/* kept alive */);
  iclassClosure?.start();
  taskAutocomplete?.start();
})().catch((err) => console.error('[server] fatal bootstrap error:', err));
```
`process.on('unhandledRejection'/'uncaughtException')` handlers stay at module top (outside the IIFE). GR bootstraps keep their existing fire-and-forget `.then(start)` form.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modify | `IClassClosureConfig { id @default("singleton"), closureIntervalMs Int @default(600000), autocompleteIntervalMs Int @default(900000), updatedAt @updatedAt }` + additive migration (do NOT seed a row) |
| `src/domain/ports/IClassClosureConfigRepository.ts` | Create | `IClassClosureConfig { closureIntervalMs; autocompleteIntervalMs }`; `get()`/`update(patch)` |
| `src/infrastructure/adapters/prisma/PrismaIClassClosureConfigRepository.ts` | Create | `(prisma as any).iClassClosureConfig`; `get()` → DEFAULTS when absent; `update()` upserts |
| `src/infrastructure/adapters/in-memory/InMemoryIClassClosureConfigRepository.ts` | Create | Mirrors Prisma contract; DEFAULTS until first persist |
| `src/application/use-cases/GetIClassClosureConfig.ts` | Create | Thin wrapper → DTO |
| `src/application/use-cases/UpdateIClassClosureConfig.ts` | Create | Validated partial patch → DTO |
| `src/application/dto/iclassClosure.dto.ts` | Modify | `IClassClosureConfigDTO`, `toIClassClosureConfigDTO`, `UpdateIClassClosureConfigSchema` (Zod) |
| `src/infrastructure/scheduling/bootstrapIClassClosure.ts` | Modify | sync→async, `(intervalMs: number)` param, drop hardcoded constant |
| `src/infrastructure/scheduling/bootstrapTaskAutocomplete.ts` | Modify | async, `(intervalMs: number)` param, drop hardcoded constant |
| `src/infrastructure/http/routes/iclass-closure.routes.ts` | Modify | GET/PUT `/closure/config` + 2 new router params |
| `src/infrastructure/http/app.ts` | Modify | Instantiate repo + 2 use cases; pass into `createIClassClosureRouter` |
| `src/main.ts` | Modify | Async IIFE startup (see above) |

## Interfaces / Contracts

```ts
// domain/ports/IClassClosureConfigRepository.ts
export interface IClassClosureConfig { closureIntervalMs: number; autocompleteIntervalMs: number; }
export interface IClassClosureConfigRepository {
  get(): Promise<IClassClosureConfig>;            // DEFAULTS {600000, 900000} when no row
  update(patch: Partial<IClassClosureConfig>): Promise<IClassClosureConfig>; // omitted fields untouched
}

// dto — Zod floor 60000, integer (mirror UpdateSyncConfigSchema; .positive() + .min(60000))
export const UpdateIClassClosureConfigSchema = z.object({
  closureIntervalMs: z.number().int().min(60000),
  autocompleteIntervalMs: z.number().int().min(60000),
}).partial().strict();

// new bootstrap signatures
export async function bootstrapIClassClosure(intervalMs: number): Promise<IClassClosureScheduler | null>
export async function bootstrapTaskAutocomplete(intervalMs: number): Promise<TaskAutocompleteScheduler | null>
```
Router gains two params **before** `requireIClassManage, authProvider`: `getConfig: GetIClassClosureConfig`,
`updateConfig: UpdateIClassClosureConfig`. Both endpoints: `auth → requirePerm('iclass','manage') → handler`.
Bad body → `400 { code: 'VALIDATION_ERROR' }` via `safeParse` (existing convention in this router).

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit (use case) | `GetIClassClosureConfig` defaults + persisted; `UpdateIClassClosureConfig` partial/full patch | InMemory repo (mirror GetSyncConfig/UpdateSyncConfig tests) |
| Unit (adapter) | InMemory contract: defaults until persist, partial merge | InMemoryIClassClosureConfigRepository.test.ts |
| Integration (routes) | GET/PUT 200; 400 floor/type/non-positive; 401 no-auth; 403 no `iclass:manage` | supertest + InMemory repo |
| Integration (bootstrap) | scheduler receives persisted `opts.intervalMs`, not hardcoded | construct via bootstrap(intervalMs), assert `scheduler.opts.intervalMs` |

Existing `IClassClosureScheduler` / `TaskAutocompleteScheduler` tests stay green (interval still an opts input).

## Migration / Rollout

Additive single migration (new table only, no seed row). Safe to leave on rollback; to revert behavior,
restore hardcoded `DEFAULT_INTERVAL_MS` and the sync `main.ts`. No data to unwind.

## Open Questions

- [ ] None blocking. FE interval control is **deferred to #31** (`closure-page-restructure`) — BE ships self-contained; UI must note "change requires server restart" (no live reload, by design).
