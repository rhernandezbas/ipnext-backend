# Tasks: Configurable Cron Intervals for IClass Closure & Autocomplete (#30)

## Phase 1: Migration & Schema

- [x] 1.1 Create migration folder `prisma/migrations/20260609000000_iclass_closure_config/` with `migration.sql` — additive `CREATE TABLE "IClassClosureConfig"` (id VARCHAR default 'singleton', closureIntervalMs INT default 600000, autocompleteIntervalMs INT default 900000, updatedAt TIMESTAMP); no seed row.
- [x] 1.2 Add `IClassClosureConfig` model to `prisma/schema.prisma` (`id @default("singleton")`, two Int fields with defaults, `@updatedAt`). Run `npx tsc --noEmit` to confirm no schema drift.

## Phase 2: Domain Port + Adapters (TDD)

- [x] 2.1 RED — Write `src/__tests__/infrastructure/adapters/in-memory/InMemoryIClassClosureConfigRepository.test.ts`: Scenario "First read returns defaults" (spec scenario 1) and "Partial update leaves untouched field unchanged" (spec scenario 2).
- [x] 2.2 GREEN — Create `src/domain/ports/IClassClosureConfigRepository.ts`: `IClassClosureConfig` interface + `IClassClosureConfigRepository` port (`get()/update()`).
- [x] 2.3 GREEN — Create `src/infrastructure/adapters/in-memory/InMemoryIClassClosureConfigRepository.ts`: module-level `DEFAULTS {600000, 900000}`; `get()` returns copy of internal state (starts as DEFAULTS); `update()` merges patch. Tests pass.
- [x] 2.4 Create `src/infrastructure/adapters/prisma/PrismaIClassClosureConfigRepository.ts`: `(prisma as any).iClassClosureConfig`; `get()` returns DEFAULTS when no row; `update()` upserts. No unit test (Prisma adapter — not tested with in-memory).

## Phase 3: Use Cases (TDD)

- [x] 3.1 RED — Write `src/__tests__/application/GetIClassClosureConfig.test.ts`: spec scenarios "Returns defaults when no record exists" (scenario 4) and "Returns current persisted config" (scenario 3) — use InMemory repo.
- [x] 3.2 GREEN — Create `src/application/use-cases/GetIClassClosureConfig.ts`: thin wrapper calling `repo.get()` and returning DTO.
- [x] 3.3 RED — Write `src/__tests__/application/UpdateIClassClosureConfig.test.ts`: spec scenarios "Full update persists both fields" (scenario 5), "Partial update only closureIntervalMs" (scenario 6) — use InMemory repo.
- [x] 3.4 GREEN — Create `src/application/use-cases/UpdateIClassClosureConfig.ts`: accepts validated patch, calls `repo.update()`, returns DTO.
- [x] 3.5 Modify `src/application/dto/iclassClosure.dto.ts`: add `IClassClosureConfigDTO`, `toIClassClosureConfigDTO`, `UpdateIClassClosureConfigSchema` (Zod `z.number().int().min(60000)`, `.partial().strict()`).

## Phase 4: Routes (TDD — supertest)

- [x] 4.1 RED — Expand `src/__tests__/infrastructure/iclass-closure.routes.test.ts` with config endpoint tests covering:
  - Spec scenario 3: GET 200 persisted values
  - Spec scenario 4: GET 200 defaults when no row
  - Spec scenario 5: PUT 200 full update
  - Spec scenario 6: PUT 200 partial update (closureIntervalMs only)
  - Spec scenario 7: PUT 400 interval below floor (30000)
  - Spec scenario 8: PUT 400 non-positive (0)
  - Spec scenario 9: PUT 400 wrong type ("soon")
  - Spec scenario 10: GET 401 no auth token
  - Spec scenario 11: PUT 403 no `iclass:manage`
  - Spec scenario 12: GET 200 authorized user succeeds
- [x] 4.2 GREEN — Modify `src/infrastructure/http/routes/iclass-closure.routes.ts`: add `getConfig: GetIClassClosureConfig` and `updateConfig: UpdateIClassClosureConfig` params; implement `GET /config` and `PUT /config` handlers (auth → requirePerm → handler; `safeParse` for validation → 400 `VALIDATION_ERROR`).

## Phase 5: App Wiring + Bootstrap Signatures

- [x] 5.1 Modify `src/infrastructure/http/app.ts`: instantiate `PrismaIClassClosureConfigRepository`, `GetIClassClosureConfig`, `UpdateIClassClosureConfig`; pass them into `createIClassClosureRouter` — mirror the GR sync config wiring pattern.
- [x] 5.2 RED — Add bootstrap-interval tests to `src/__tests__/infrastructure/TaskAutocompleteScheduler.test.ts` (or a sibling): spec scenario 14 (autocomplete scheduler receives `opts.intervalMs = 300000` from bootstrap param) and scenario 16 (default 900000 when no record — bootstrap called with default arg).
- [x] 5.3 GREEN — Modify `src/infrastructure/scheduling/bootstrapIClassClosure.ts`: `async function bootstrapIClassClosure(intervalMs: number)` — drop `DEFAULT_INTERVAL_MS`, pass `intervalMs` into scheduler opts. Covers spec scenario 13 and 15.
- [x] 5.4 GREEN — Modify `src/infrastructure/scheduling/bootstrapTaskAutocomplete.ts`: `async function bootstrapTaskAutocomplete(intervalMs: number)` — drop hardcoded constant, pass `intervalMs` into scheduler opts.
- [x] 5.5 Modify `src/main.ts`: wrap startup in async IIFE — `new PrismaIClassClosureConfigRepository()` → `configRepo.get()` → `await bootstrapIClassClosure(cfg.closureIntervalMs)` → `await bootstrapTaskAutocomplete(cfg.autocompleteIntervalMs)` → `createApp(taskAutocomplete)` → `app.listen`; GR bootstraps remain fire-and-forget after listen.

## Phase 6: Regression & Final Verify

- [x] 6.1 Confirm existing `IClassClosureScheduler` and `TaskAutocompleteScheduler` tests still pass — interval is already injected via opts, so signature change is non-breaking. Run `npx jest TaskAutocompleteScheduler --runInBand`.
- [x] 6.2 Confirm GR cron bootstraps and their tests are untouched. Run `npx jest gestion-real --runInBand`.
- [x] 6.3 Full suite green: `npx jest --runInBand`. Verify spec scenario 16 (no-restart behavior): scheduler opts are set at bootstrap time and do not change after `PUT /closure/config`.
- [x] 6.4 Type-check: `npx tsc --noEmit` — zero errors.
