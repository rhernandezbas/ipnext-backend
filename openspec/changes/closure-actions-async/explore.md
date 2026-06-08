## Exploration: closure-actions-async (#32)

### Current State

The system has three logical parts to address:

**Part 1 — Backfill sync (the timeout problem)**
`POST /closure/backfill` calls `backfillClosedOrders.execute()` synchronously and waits for the full result before responding (routes/iclass-closure.routes.ts:99–105). `BackfillClosedServiceOrders.execute()` (application/use-cases/BackfillClosedServiceOrders.ts:47–64) does:
1. `listTasksInIClassStage('registered_in_iclass')` → ~78 tasks currently
2. For each task → `iclass.listServiceOrders(...)` (one HTTP call per task = ~78 sequential IClass calls)
3. For each matching summary → `ingest.processSummary(s, counts)` which itself does fan-out IClass sub-resource calls (history, checklists, materials, equipment) AND runs `runClosureSideEffects` (OCR via OllamaDevicePhotoOcr + audit via OllamaInstallationAuditor)

The closure `IngestClosedServiceOrders` instance injected into `BackfillClosedServiceOrders` (app.ts:1237–1243, 1255) is built with `buildClosureSideEffects()` which wires OCR (`ICLASS_OCR_ENABLED=true`) and the audit (`OllamaInstallationAuditor`, runtime-gated by `iclass-audit` flag). This means every HTTP backfill request can trigger 78+ IClass API calls + N Ollama LLM calls, causing HTTP timeouts.

**Part 2 — All sync LLM/heavy entry points**

| Entry Point | File:Line | What it triggers | Already async? |
|-------------|-----------|------------------|----------------|
| `POST /closure/backfill` | iclass-closure.routes.ts:99 | 78+ IClass calls × (4 sub-resource calls + OCR Ollama + audit Ollama) via BackfillClosedServiceOrders→IngestClosedServiceOrders.processSummary→runClosureSideEffects | NO — sync, awaits full result, returns 200 |
| `POST /closure/reprocess` | iclass-closure.routes.ts:110 | scheduler.triggerNow() → fire-and-forget runOnce(manualReprocess) → ReprocessClosureSideEffects → runClosureSideEffects per pending SO | YES — 202, fire-and-forget via TaskAutocompleteScheduler.triggerNow() (#23) |
| `POST /result-codes/sync` | iclass-closure.routes.ts:56 | SyncIClassResultCodes → single IClass.listResultCodes() bulk call | N/A — single paginated call, fast, no loop per-task, no LLM |
| TaskAutocompleteScheduler cron | scheduling/TaskAutocompleteScheduler.ts:54 | ReprocessClosureSideEffects → runClosureSideEffects per pending SO | N/A — cron, not HTTP |
| IClassClosureScheduler cron | scheduling/IClassClosureScheduler.ts:51 | IngestClosedServiceOrders.execute() → bulk listServiceOrders + processSummary per SO | N/A — cron, not HTTP |
| `POST /:id/iclass/resend` | scheduling.routes.ts:315 | ResendTaskToIClassWithNode → single task dispatch, no LLM | N/A — single task op, fast |

**Summary of the problem**: Only ONE HTTP entry point is sync with heavy work — `POST /closure/backfill`. The reprocess is already async. No other HTTP routes call Ollama/OCR directly.

**Part 3 — The async pattern to reuse (#23)**
`TaskAutocompleteScheduler` (scheduling/TaskAutocompleteScheduler.ts) provides:
- `inFlight: boolean` guard — only one run at a time
- `PgAdvisoryLock` — prevents concurrent runs across instances (lock key: `'task-autocomplete'`)
- `triggerNow()` — reads manual flag, returns `TriggerResult` immediately, calls `void this.runOnce(manualReprocess)` fire-and-forget
- `runOnce(reprocess?)` — acquires lock, sets inFlight, runs, releases

The backfill is DIFFERENT from reprocess in its dependencies:
- Reprocess uses `ReprocessClosureSideEffects` (reads pending from DB, re-fires side effects only)
- Backfill uses `BackfillClosedServiceOrders` (queries IClass per in-flight task, runs full processSummary incl. mirror + transition + side effects)

Two options for async backfill:
1. **Extend TaskAutocompleteScheduler** — add a second `triggerBackfillNow()` method with its own lock key and in-flight flag, wired to a `BackfillClosedServiceOrders` instance.
2. **New `BackfillScheduler`** — simpler dedicated class mirroring the pattern (inFlight + PgAdvisoryLock + `triggerNow()` → 202).

Option 2 is cleaner (single-responsibility, no coupling of two unrelated operations into one scheduler class). Option 1 is DRY but bloats `TaskAutocompleteScheduler`. Given the backfill has no recurring cron (it's manual-only), a very thin standalone fire-and-forget guard is sufficient.

**Part 4 — runClosureSideEffects / processSummary LLM path**
`IngestClosedServiceOrders.runClosureSideEffects()` (IngestClosedServiceOrders.ts:252–327):
1. OCR: loops checklist photos → `this.extractOcr.execute(...)` → `OllamaDevicePhotoOcr` (Ollama HTTP call) — only when `ICLASS_OCR_ENABLED=true` and photo is device type
2. Audit: `this.auditInstallation.execute(...)` → `AuditInstallationQuality.execute()` which first checks `iclass-audit` flag (DB) — only calls `OllamaInstallationAuditor.audit()` when flag is ON

The audit is runtime-gated by the `iclass-audit` feature flag (AuditInstallationQuality.ts:35–39). The OCR is env-gated by `ICLASS_OCR_ENABLED`. Both paths reach Ollama only if their respective gates are open. The backfill DOES reach this path via `processSummary` → `runClosureSideEffects`.

**Part 5 — FE: the count + table today**
- `IClassClosureFlagBody.tsx`: uses `usePendingCount()` → `GET /closure/reprocess/pending-count` → renders as plain text `"Quedan {pending} pendientes"` (line 241–244). NOT clickable.
- `ClosureProgressTable.tsx`: standalone component, renders table from `usePendingList()` → `GET /closure/reprocess/pending-list`. Has `Link` to task detail per row.
- Both live together in `IClassSettingsBody.tsx`'s "cierre/Procesamiento" sub-tab (IClassSettingsBody.tsx:17–26): `<IClassClosureFlagBody /><ClosureIntervalConfig /><ClosureProgressTable />`
- `IClassSettingsBody.tsx` itself is a sub-tab of `SchedulingSettingsPage.tsx` under the "iclass" tab.

**Part 6 — FE routing**
`App.tsx` scheduling routes (lines 216–236):
```
/admin/scheduling/
  tasks          → SchedulingTasksPage
  tasks/:id      → SchedulingTaskDetailPage
  settings       → SchedulingSettingsPage (permission: scheduling.read)
  ...
```
No `iclass.manage` permission on the settings route — it uses `scheduling.read`. The `requireIClassManage` permission guard is on specific backend endpoints only.

For a new standalone pending page: add `<Route path="iclass/closure/pending" element={<RequirePermission permission="iclass.manage"><ClosurePendingPage /></RequirePermission>} />` inside the `scheduling` Route block in App.tsx. The `ClosureProgressTable` moves there and the count in `IClassClosureFlagBody` becomes a `<Link to="/admin/scheduling/iclass/closure/pending">N pendientes</Link>`.

**Part 7 — Existing tests**
BE:
- `src/__tests__/infrastructure/iclass-closure.routes.test.ts` — route tests for reprocess, pending-count, pending-list, config (uses stub backfill). Does NOT test backfill async behavior.
- `src/__tests__/infrastructure/TaskAutocompleteScheduler.test.ts` — tests cron paths and `triggerNow()`.
- `src/__tests__/application/BackfillClosedServiceOrders.test.ts` — unit test for the use case (file exists).
- `src/__tests__/application/GetPendingSideEffectsCount.test.ts` — unit tests for the count use case.

FE:
- `src/__tests__/scheduling/settings/IClassClosureFlagBody.test.tsx` — tests toggle, backfill, reprocess, pending count display.
- `src/__tests__/scheduling/settings/ClosureProgressTable.test.tsx` — tests table rendering.
- `src/__tests__/scheduling/settings/IClassSettingsBody.test.tsx` — tests sub-tab structure.

---

### Affected Areas

**Backend**
- `src/infrastructure/http/routes/iclass-closure.routes.ts` — change backfill POST from sync 200 to async 202
- `src/infrastructure/http/app.ts:1255` — wire new BackfillScheduler (or inline guard)
- New file: `src/infrastructure/scheduling/BackfillScheduler.ts` (or inline in app.ts if tiny)
- `src/__tests__/infrastructure/iclass-closure.routes.test.ts` — update backfill test: 202 instead of 200
- `src/__tests__/infrastructure/BackfillScheduler.test.ts` (new)

**Frontend**
- `src/pages/scheduling/settings/IClassClosureFlagBody.tsx` — count becomes `<Link>`
- `src/pages/scheduling/settings/IClassSettingsBody.tsx` — remove `<ClosureProgressTable />` from Procesamiento sub-tab
- `src/App.tsx` — add route `scheduling/iclass/closure/pending`
- New: `src/pages/scheduling/ClosurePendingPage.tsx` — standalone page with `ClosureProgressTable`
- `src/__tests__/scheduling/settings/IClassClosureFlagBody.test.tsx` — update count renders as Link
- `src/__tests__/scheduling/settings/IClassSettingsBody.test.tsx` — table no longer in sub-tab
- New: `src/__tests__/scheduling/ClosurePendingPage.test.tsx`

---

### Approaches

**Approach A — New BackfillScheduler class (recommended)**
- Mirror `TaskAutocompleteScheduler` structure but for backfill: `inFlight` guard + `PgAdvisoryLock` + `triggerNow()` returns `TriggerResult` (202)
- New lock key: `'iclass-closure-backfill'`
- No cron timer — backfill is manual-only
- Route: POST /closure/backfill → 202 `{queued:true}` | `{queued:false, reason:'already-running'}`
- No flag gate needed (backfill is admin-only, no feature flag)
- Pros: clean SRP, matches existing scheduler pattern exactly, independent inFlight tracking
- Cons: new file, more code
- Effort: Low

**Approach B — Add triggerBackfillNow() to TaskAutocompleteScheduler**
- Add second inFlight guard + method to existing scheduler
- Pros: reuses existing class
- Cons: couples two unrelated operations, harder to test independently, TaskAutocompleteScheduler already has dual-mode complexity
- Effort: Low but produces worse code

**Approach C — Simple inline lock in route handler**
- In the route handler, use a module-level `let backfillInFlight = false` + fire-and-forget
- No PgAdvisoryLock across instances
- Pros: minimal code
- Cons: does not protect against multi-instance race conditions, not testable via unit tests
- Effort: Very Low but wrong for production

---

### Recommendation

**Approach A** — new `BackfillScheduler` class. The pattern is already battle-tested in `TaskAutocompleteScheduler`. A thin class (no cron timer, just inFlight + PgAdvisoryLock + `triggerNow()`) is ~40 lines and follows the established pattern exactly. The FE change (count → Link + standalone page) is a straightforward page split.

The `ClosureProgressTable` moving to a standalone page is additive: the FE component already exists, just needs a new route and a page wrapper. The count `<Link>` change is trivial.

Regarding the "ALL LLM/heavy actions" audit from part 2: **only `POST /closure/backfill` needs to be made async.** The reprocess is already async (#23). No other HTTP entry points trigger Ollama or IClass per-task loops.

---

### Risks

1. **Backfill result lost**: caller currently reads `{mirrored, transitioned, ...}` synchronously. The 202 pattern returns `{queued:true}` — the actual counts are never returned to the caller. FE currently shows a success banner with counts from the backfill result. After this change, the banner must change to "Reconciliación encolada. El proceso corre en segundo plano." The FE must handle the new response shape.
2. **In-flight transparency**: once async, there's no endpoint to query backfill progress. The pending-list polling already shows the queue draining. No new endpoint needed unless the product wants it.
3. **PgAdvisoryLock key collision**: must pick a distinct key — `'iclass-closure-backfill'` doesn't exist yet.
4. **The closureIngest instance** passed to BackfillClosedServiceOrders in app.ts is shared with the IClassClosureScheduler. Concurrent backfill + cron both call processSummary on the same shared ingest instance. This is safe because `IngestClosedServiceOrders` is stateless (no instance state). But the PgAdvisoryLock ensures the backfill doesn't overlap itself.
5. **FE: route permission** — the new standalone pending page should require `iclass.manage` (like the count/list endpoints), not just `scheduling.read`. The `Can` component already wraps the relevant sections in `IClassClosureFlagBody`.

---

### Ready for Proposal

Yes — all 6 questions answered with file:line evidence. The scope is clear:
- 1 BE change: make backfill async with a new `BackfillScheduler`
- 1 FE change: count → Link + ClosureProgressTable moves to `/admin/scheduling/iclass/closure/pending`
- No schema changes, no new ports, no new endpoints
