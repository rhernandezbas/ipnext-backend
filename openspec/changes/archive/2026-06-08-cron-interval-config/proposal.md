# Proposal: Configurable Cron Intervals for IClass Closure & Autocomplete (#30)

## Intent

The two IClass closure schedulers — `IClassClosureScheduler` (10 min) and `TaskAutocompleteScheduler` (15 min) — have their intervals hardcoded as `DEFAULT_INTERVAL_MS` in their bootstraps. Operators cannot tune them without a code change + redeploy. The GR crons already solved this with a persisted single-row config table + GET/PUT endpoint. This change brings the same operator control to the IClass closure crons.

## Scope

### In Scope
- One shared `IClassClosureConfig` singleton table (`closureIntervalMs`, `autocompleteIntervalMs`).
- Domain port `IClassClosureConfigRepository` (`get()`/`update()`) + Prisma + in-memory adapters.
- Use cases `GetIClassClosureConfig` / `UpdateIClassClosureConfig` (verb+noun, one file each).
- `GET` + `PUT /closure/config` on the existing iclass-closure router, guarded `requirePerm('iclass','manage')`.
- Bootstraps read persisted intervals at startup: `bootstrapIClassClosure` (sync→async), `bootstrapTaskAutocomplete` (already async-capable).
- `main.ts` startup wrapped in an async IIFE to await the now-async bootstrap before `createApp`.

### Out of Scope
- Live-reload of the interval — a change takes effect on next server restart (documented in UI helper text).
- A generic key-value config store (over-engineering; not established).
- Any change to the GR sync/ingest config tables or endpoints.
- The FE interval control — lands inside #31's restructured "Procesamiento" page (or a tiny follow-up). #30 ships BE-first and self-contained.

## Capabilities

### New Capabilities
- `iclass-closure-config`: persisted, operator-tunable interval configuration for the IClass closure and task-autocomplete schedulers, exposed via GET/PUT `/closure/config` and consumed by the bootstraps at startup.

### Modified Capabilities
- None (no existing file-based specs; the scheduler classes already accept `intervalMs` via opts — only the injection source changes).

## Approach

Mirror the proven GR config-repo pattern (Option B from exploration — one shared table, lightest path):
1. Single additive migration for `IClassClosureConfig` (id `singleton`, two interval Ints, `updatedAt`).
2. Port `get()` returns module-level `DEFAULTS` when no row exists (zero DB writes); `update(patch)` upserts.
3. Thin use cases wrap the port; router exposes GET/PUT with Zod validation, DTO-mapped responses.
4. Bootstraps call `.get()` and pass `persisted.{closure,autocomplete}IntervalMs` into the scheduler opts instead of the hardcoded constant. The interval is read **once at startup** (matches GR — no live reload).
5. `main.ts` becomes an async IIFE so `await bootstrapTaskAutocomplete()` precedes `createApp(taskAutocomplete)`.

Defaults preserve current behavior: `closureIntervalMs = 600000`, `autocompleteIntervalMs = 900000`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | New | `IClassClosureConfig` model + additive migration |
| `src/domain/ports/IClassClosureConfigRepository.ts` | New | Port interface |
| `src/infrastructure/adapters/prisma/PrismaIClassClosureConfigRepository.ts` | New | Prisma adapter |
| `src/infrastructure/adapters/in-memory/InMemoryIClassClosureConfigRepository.ts` | New | In-memory adapter (tests) |
| `src/application/use-cases/GetIClassClosureConfig.ts` | New | Read use case |
| `src/application/use-cases/UpdateIClassClosureConfig.ts` | New | Update use case |
| `src/application/dto/iclassClosure.dto.ts` | Modified | Config DTO + Zod schema |
| `src/infrastructure/scheduling/bootstrapIClassClosure.ts` | Modified | sync→async, read config |
| `src/infrastructure/scheduling/bootstrapTaskAutocomplete.ts` | Modified | read config |
| `src/infrastructure/http/routes/iclass-closure.routes.ts` | Modified | GET/PUT `/closure/config` |
| `src/infrastructure/http/app.ts` | Modified | Wire new use cases into router factory |
| `src/main.ts` | Modified | Async IIFE startup |
| FE (#31 page / follow-up) | Deferred | Interval inputs + api calls |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Async bootstrap breaks sync `createApp(taskAutocomplete)` injection in `main.ts` | High | Wrap `main.ts` in async IIFE (idiomatic); `await` bootstrap before `createApp` |
| Prisma client not yet regenerated for new table | Med | Use `(prisma as any).iClassClosureConfig` accessor until regen, same as GR adapters |
| #30 BE and #31 page restructure conflict if parallel | Med | #30 is BE-only; FE control rides #31 or a follow-up — coordinate branch order |
| Operators expect live interval change | Low | UI helper text: change requires server restart (matches GR) |

## Rollback Plan

Migration is additive (new table only) — safe to leave in place. To revert behavior: restore the hardcoded `DEFAULT_INTERVAL_MS` injection in both bootstraps and revert `main.ts` to the sync call. The unused table/port/adapter/endpoint can be dropped in a follow-up. No data migration to unwind.

## Dependencies

- Prisma client regeneration for the new model (or `as any` accessor interim).
- FE interval control depends on #31 (`closure-page-restructure`) or ships as a small follow-up.

## Success Criteria

- [ ] `GET /closure/config` returns persisted values, or defaults (600000 / 900000) when no row exists.
- [ ] `PUT /closure/config` accepts partial patches and persists them (RBAC `iclass:manage`).
- [ ] After a restart, both schedulers run on the DB-persisted intervals, not the hardcoded constants.
- [ ] New use-case and in-memory adapter tests pass (strict TDD, mirroring GR sync config tests).
- [ ] Existing scheduler tests remain green (interval still injected via opts).
