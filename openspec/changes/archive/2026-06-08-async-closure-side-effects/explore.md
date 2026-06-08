# Exploration: async-closure-side-effects (backlog #23)

## Current State

### Q1 — Reprocess flow today

`ReprocessClosureSideEffects.execute()` is a synchronous-in-HTTP use case:

1. Reads feature flag `iclass-closure-reprocess` (DB). If OFF → returns `{skipped:true}` immediately (fast path — no timeout risk).
2. Calls `closed.listPendingSideEffects(maxAuditAttempts=3)` — returns all mirrors where `commentPosted=false OR inventoryBuilt=false OR (auditDone=false AND auditAttempts < 3)`.
3. For each pending SO with a linked `scheduledTaskId`:
   a. Fetches full aggregate: `closed.getByIclassId(p.iclassId)`.
   b. Calls `runner.runClosureSideEffects(order, taskId)` — this is `IngestClosedServiceOrders.runClosureSideEffects`.
      - OCR: iterates `order.checklists` → for each Foto answer matching SN/MAC device type → calls `extractOcr.execute(photoUrl)` → **Ollama call, 120 s timeout per photo**.
      - Inventory: `buildSuggestions.execute(...)` → marks `inventoryBuilt` only when no OCR failure.
      - Comment: `postComment.execute(...)` → marks `commentPosted`.
      - Audit: if `auditAttempts < 3` → `auditInstallation.execute(...)` → **Ollama call, 180 s timeout, up to 8 photos in a single multimodal request** → marks `auditDone`.
4. Per-SO isolation: one throw never aborts the batch (caught, counted).
5. Returns `{skipped, candidates, processed, noTask}`.

**Who calls it**: `POST /api/admin/iclass/closure/reprocess` (mount point `/api/admin/iclass`).  
**Route guards**: `auth` middleware + `requireIClassManage` (granular `iclass:manage` permission).  
**Response contract today**: `200 OK { skipped, candidates, processed, noTask }` — FE awaits the full result synchronously via `mutateAsync()`.  
**Blocking point**: for N pending SOs with unprocessed photos, total latency ≈ N × (8 × 120s OCR + 180s audit). With the #20 mass auditDone reset, N could be hundreds. Under a default 120 s proxy/LB timeout → guaranteed "No se pudo reprocesar" from the client, even though the backend keeps running.

### Q2 — Closure loop + TaskAutocompleteScheduler

**IClassClosureScheduler** (`src/infrastructure/scheduling/IClassClosureScheduler.ts`):
- `setInterval` at 10 min, bootstrapped in `main.ts` via `bootstrapIClassClosure()`.
- Guards: `inFlight` boolean (in-process skip) + `PgAdvisoryLock('iclass-closed')` (cross-instance).
- Re-reads `iclass-closure-loop` flag on every tick → toggleable without redeploy.
- Calls `IngestClosedServiceOrders.execute()` which calls `runClosureSideEffects()` inline for each newly mirrored SO. So the closure loop also runs OCR+audit synchronously — but inside a background interval, so no HTTP timeout risk there. It does NOT process already-mirrored SOs with pending effects.

**TaskAutocompleteScheduler** (`src/infrastructure/scheduling/TaskAutocompleteScheduler.ts`):
- `setInterval` at 15 min, bootstrapped in `main.ts`.
- Guards: `inFlight` boolean + `PgAdvisoryLock('task-autocomplete')`.
- Re-reads `task-autocomplete` flag on every tick.
- Calls `ReprocessClosureSideEffects.execute()` with `flagKey='task-autocomplete'` — same use case, different flag key.
- This is the exact async background model needed for the HTTP endpoint: enqueue + return immediately, let the scheduler do the work.

**Conclusion**: `TaskAutocompleteScheduler` IS already the background runner for reprocess. The HTTP endpoint is redundant with it but forces a manual trigger instead of waiting for the next tick.

### Q3 — Concurrency / locking

**Existing guards**:
- `inFlight: boolean` on each scheduler — in-process re-entrancy guard. If the timer fires while a run is still active, the new tick is skipped.
- `PgAdvisoryLock(key)` — cross-instance (multi-replica) advisory lock via `pg_try_advisory_lock`. Acquired in `tryAcquire`, released in `finally`. If the process crashes, PG auto-releases (session lock). No stale-lock risk.
- The HTTP endpoint has NO in-flight guard and NO lock. Two concurrent `POST /closure/reprocess` calls run simultaneously, both iterating the same `listPendingSideEffects` result. Idempotency is at the per-SO effect level (each side-effect is skipped if already marked done), so double-processing is mostly harmless but wasteful and could double the Ollama load.

**`auditAttempts` / `maxAuditAttempts`**: `DEFAULT_MAX_AUDIT_ATTEMPTS = 3`. `incrementAuditAttempt` is called BEFORE calling the model; if `auditAttempts >= max`, the SO is not returned by `listPendingSideEffects`. Cap prevents Ollama hammering.

**`inventoryBuilt` flag**: marked `true` only when OCR produced zero failures. If any photo fails (LLM down, timeout), the flag stays `false` and the full OCR run is retried on the next reprocess — not just the failed photos (no partial-photo tracking).

### Q4 — Side-effect tracking

`ClosureSideEffectState` (domain port `ClosedServiceOrderRepository`):
```ts
{ commentPosted: boolean; inventoryBuilt: boolean; auditDone: boolean; auditAttempts: number }
```

Backed by DB columns on the `ClosedServiceOrderMirror` table (Prisma). Accessed via:
- `getSideEffectState(iclassId)` — current state
- `listPendingSideEffects(maxAuditAttempts)` — all SOs with ≥1 pending effect
- `markSideEffect(iclassId, effect, done)` — atomic flip
- `incrementAuditAttempt(iclassId)` — increment + lastAuditAttemptAt

**For FE polling after 202**: the FE could poll `GET /api/admin/iclass/closure/status` (already exists, returns last run counts from `SyncState`) OR a new `GET /closure/reprocess/status` endpoint returning aggregate counts from `listPendingSideEffects`. The per-SO flags are sufficient to show progress. The `#14 completeness flags` (`closureAuditDone`, `closureCommentDone`, `closureHasDeviceInventory`) on `ScheduledTask` are also available.

### Q5 — Reprocess endpoints + FE

**Backend**:
- Single route: `POST /api/admin/iclass/closure/reprocess`
- No bulk variant; the use case itself processes all pending SOs in one batch.
- Guard: `auth` + `requireIClassManage`.

**Frontend**:
- `src/api/iclassClosure.api.ts` — `iclassClosureApi.reprocess()` — typed `ClosureReprocessResult`.
- `src/hooks/useIClassClosure.ts` — `useReprocessClosure()` — `useMutation`.
- `src/pages/scheduling/settings/IClassClosureFlagBody.tsx` — the "Reprocesar side-effects pendientes" card in the IClass settings sub-tab. Button calls `handleReprocess()` → `reprocess.mutateAsync()` → awaits `200 {skipped, candidates, processed, noTask}`. Shows inline banner with counts.
- When the response becomes `202 {queued: true}`, the FE needs to: (a) update the button state to "Encolado" / remove spinner, (b) optionally poll for completion and show progress. The existing `reprocess.isError` banner covers the 4xx case unchanged.

### Q6 — Infra constraints

- **Single Node process**: yes — all schedulers (`IClassClosureScheduler`, `TaskAutocompleteScheduler`, GR sync) run in-process via `setInterval`. In-process queue (a simple `Promise` chain or immediate background `void fn()`) is the right model.
- **No existing job queue**: no Bull, BullMQ, Bee-Queue, or similar. The schedulers use raw `setInterval` + `PgAdvisoryLock` for cross-replica coordination.
- **Long-running background work**: the `PgAdvisoryLock` uses a dedicated `pg.Client` (not the Prisma pool) — it survives for the process lifetime. The `main.ts` registers `unhandledRejection` + `uncaughtException` handlers that log and keep the process alive. There is no forced restart on deploy that would kill an in-flight job; deploys are manual or container restarts.
- **OCR timeout**: `OCR_TIMEOUT_MS` defaults to 120 s per photo (`config.ocr.timeoutMs`). Each OCR call is sequential (not parallelized within a checklist loop). With 8 photos × 120 s = 16 min possible per SO just for OCR.
- **Audit timeout**: `AUDIT_TIMEOUT_MS` defaults to 180 s; `maxPhotos=8` (DEFAULT_MAX_PHOTOS in `OllamaInstallationAuditor`). Single multimodal request with all photos at once.
- **Total worst-case per SO**: 16 min (OCR) + 3 min (audit) = ~19 min. For 100 SOs = ~31 h. The SYNC endpoint (200 + await) can never serve this.

### Q7 — Existing tests

| File | Covers |
|------|--------|
| `src/__tests__/application/ReprocessClosureSideEffects.test.ts` | Flag OFF skip, pending re-fire, failure isolation, audit cap, integration with real runner |
| `src/__tests__/infrastructure/iclass-closure.routes.test.ts` | POST /closure/reprocess → 200 + counts body; auth 401 |
| `src/__tests__/infrastructure/TaskAutocompleteScheduler.test.ts` | inFlight skip, lock skip, processed result |
| `src/__tests__/infrastructure/IClassClosureScheduler.test.ts` | closure loop scheduler guards |

No test covers: 202 async response from the route, any polling/status endpoint, or the async dispatch path.

## Affected Areas

- `src/infrastructure/http/routes/iclass-closure.routes.ts` — change reprocess route response: 202 + enqueue; add optional status GET
- `src/application/use-cases/ReprocessClosureSideEffects.ts` — unchanged (the runner itself is fine; async is in dispatch)
- `src/infrastructure/scheduling/TaskAutocompleteScheduler.ts` — can be reused or cloned as the background runner for manual triggers
- `src/infrastructure/scheduling/bootstrapTaskAutocomplete.ts` — may need to expose `scheduler.runOnce()` so the HTTP endpoint can trigger it
- `src/infrastructure/http/app.ts` — wiring: pass scheduler reference to the closure router
- `src/infrastructure/scheduling/closureSideEffects.ts` — no change needed
- `src/__tests__/infrastructure/iclass-closure.routes.test.ts` — update for 202 response
- `src/__tests__/infrastructure/TaskAutocompleteScheduler.test.ts` — extend for triggered-run scenarios
- `C:\Users\ronald\projects\ipnext\ipnext-frontend\src\api\iclassClosure.api.ts` — type 202 response
- `C:\Users\ronald\projects\ipnext\ipnext-frontend\src\hooks\useIClassClosure.ts` — handle queued state
- `C:\Users\ronald\projects\ipnext\ipnext-frontend\src\pages\scheduling\settings\IClassClosureFlagBody.tsx` — show "encolado" state

## Approaches

### Option A — HTTP trigger kicks `TaskAutocompleteScheduler.runOnce()` immediately

The HTTP endpoint calls `taskAutocompleteScheduler.runOnce()` without `await` (fire-and-forget). Returns `202 { queued: true }` immediately. The scheduler's existing `inFlight` guard prevents double-processing if already running.

- Pros: zero new infrastructure; reuses existing lock + guard; minimal code change; consistent with the auto cron model; the `inFlight` guard naturally prevents concurrent manual+auto overlap.
- Cons: requires wiring the scheduler reference into the route factory (currently not in scope); if the process restarts mid-job, the job is lost (acceptable per the spec — the next auto-complete tick will catch up).
- Effort: Low

### Option B — Dedicated `AsyncReprocessQueue` (in-process job queue)

Introduce a thin `AsyncReprocessQueue` class (wraps a `Promise` chain) in application layer; the HTTP endpoint enqueues a job; a background worker drains. Returns 202 immediately.

- Pros: decouples the HTTP trigger from the scheduler; can expose queue depth/status.
- Cons: more moving parts; essentially reimplements what `TaskAutocompleteScheduler` already does; still in-process (same crash risk).
- Effort: Medium

### Option C — Delegate to `TaskAutocompleteScheduler` via a `triggerNow()` method

Add a `triggerNow(): Promise<void>` method to `TaskAutocompleteScheduler` that does `void this.runOnce()` and returns immediately. The route calls `scheduler.triggerNow()` → returns 202.

- Pros: cleanest API; the scheduler remains the single owner of the background logic; easy to test (spy on runOnce).
- Cons: requires exposing the scheduler reference to the route — same as Option A but with a cleaner named method.
- Effort: Low

## Recommendation

**Option C** — add `triggerNow()` to `TaskAutocompleteScheduler` and wire it into the HTTP endpoint.

Rationale:
1. The scheduler is ALREADY the background runner for the same use case (same `ReprocessClosureSideEffects`). Unifying the manual trigger with it is architecturally correct.
2. `inFlight` guard already prevents double-processing from concurrent HTTP calls or overlapping cron ticks.
3. `PgAdvisoryLock` already handles multi-replica scenarios.
4. The response contract change is minimal: `202 { queued: true }` instead of `200 { skipped, candidates, processed, noTask }`.
5. For FE progress: the existing `GET /closure/status` returns the last run counts — sufficient for a "check later" UX. A dedicated polling endpoint is optional (post-MVP).

**FE changes**: minimal — handle 202 (`queued: true`), show a toast "Reprocesamiento encolado", disable the button during the in-flight run (the scheduler sets `inFlight` so a second trigger immediately returns skipped).

## Risks

- **In-flight job lost on deploy/crash**: a background run interrupted by a process restart will leave some SOs partially processed. The `inventoryBuilt` and `auditDone` flags prevent re-running already-completed effects; partially done SOs will be retried on the next `task-autocomplete` tick. Acceptable per spec.
- **#20 mass reset**: when `iclass-audit` flag is turned ON after the #20 migration reset `auditDone` for all records, `listPendingSideEffects` will return ALL previously audited SOs. With 100+ SOs and 3 min per audit, the background run will take hours. The `inFlight` guard ensures only one batch runs at a time; the `auditAttempts` cap prevents infinite retries for broken models. No HTTP timeout risk with the async approach.
- **No FE progress feedback**: the 202 response gives no progress signal. The FE can poll `GET /closure/status` (last cron run result) but it's indirect. A dedicated `GET /closure/reprocess/pending-count` endpoint (trivially thin over `listPendingSideEffects`) would enable a real progress bar — recommended but not blocking.
- **Double-trigger race**: if the operator clicks "Reprocesar" twice in quick succession before the first trigger sets `inFlight=true`, two parallel runs could start. Mitigation: the `PgAdvisoryLock` ensures only one runs per replica; the `inFlight` guard handles within the same process. The per-SO idempotency of side-effect flags prevents actual duplication.
- **OCR partial-photo tracking**: `inventoryBuilt` stays `false` if ANY photo OCR fails — the entire OCR set is retried. With 8 photos and one consistently failing, OCR runs forever up to the audit cap equivalent. No OCR attempt cap exists today. Potentially add `ocrAttempts` tracking (out of scope for #23 but worth noting).

## Ready for Proposal

Yes — the exploration is conclusive. The change is well-scoped: one new method on `TaskAutocompleteScheduler`, one route response change (200→202), wiring in `app.ts`, and FE state update. No new infrastructure required.
