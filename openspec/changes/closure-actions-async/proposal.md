# Proposal: Closure Actions Async (#32)

## Intent

`POST /closure/backfill` runs **synchronously**: one HTTP request fans out to ~78 sequential IClass calls plus per-SO OCR/audit Ollama calls, blocking until the full result returns. This causes HTTP timeouts. The requirement is "all LLM/heavy closure actions async". An audit (see Evidence) proves only the backfill remains sync — reprocess is already async (#23). This change makes the backfill fire-and-forget (202) and splits the FE pending view into a standalone page.

## Scope

### In Scope
- New `BackfillScheduler` (infra): `inFlight` guard + `PgAdvisoryLock` key `iclass-closure-backfill` + `triggerNow()` → `TriggerResult`.
- `POST /closure/backfill` returns **202** (queued union) / **503** when scheduler null — same contract as reprocess.
- Wire `BackfillScheduler` in `app.ts:1255` with the existing `BackfillClosedServiceOrders` instance.
- FE: backfill banner shows "Reconciliación encolada" / "Ya hay una reconciliación en curso" instead of counts.
- FE: new standalone `ClosurePendingPage` at `/admin/scheduling/iclass/closure/pending` (gated `iclass.manage`); `ClosureProgressTable` **moves** there; pending count becomes a `<Link>`.

### Out of Scope
- Changing OCR (`ICLASS_OCR_ENABLED`) / audit (`iclass-audit` flag) gating.
- Job queue (BullMQ) / progress endpoint beyond the existing pending-list.
- Touching reprocess (already async, #23).

## Capabilities

### New Capabilities
- `closure-backfill-async`: admin-triggered backfill runs in background; route returns a queued/already-running TriggerResult, guarded by a cross-instance advisory lock.

### Modified Capabilities
- None (reprocess/result-codes/crons unchanged at spec level).

## Approach

**Approach A (recommended, exploration).** New thin `BackfillScheduler` mirroring `TaskAutocompleteScheduler` but **without cron** — manual-only: `inFlight` + `PgAdvisoryLock('iclass-closure-backfill')` + `triggerNow()` that returns immediately and `void`s `runOnce()` (fire-and-forget). Route handler matches reprocess: `if (!scheduler) 503; else 202 triggerNow()`. No flag gate (admin-only). Dedicated class over extending the scheduler (SRP; different deps; no shared cron). FE splits the pending table into its own permission-gated page; the count links to it.

### Evidence — sync LLM/heavy entry-point audit (Part 2)

| Entry point | Heavy? | Async? |
|-------------|--------|--------|
| `POST /closure/backfill` | 78+ IClass + OCR/audit Ollama | **NO → this change** |
| `POST /closure/reprocess` | side-effects per SO | YES (202, #23) |
| `POST /result-codes/sync` | single bulk call | N/A fast |
| `POST /:id/iclass/resend` | single task | N/A fast |
| TaskAutocomplete / IClassClosure crons | loops + LLM | N/A background |

Only the backfill is sync+heavy → "all LLM async" reduces to this fix.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/infrastructure/scheduling/BackfillScheduler.ts` | New | inFlight + lock + triggerNow |
| `src/infrastructure/http/routes/iclass-closure.routes.ts` | Modified | backfill → 202/503 |
| `src/infrastructure/http/app.ts` (~1255) | Modified | wire BackfillScheduler |
| BE tests (routes + new scheduler) | New/Modified | 202 contract; scheduler unit |
| FE `IClassClosureFlagBody.tsx`, `iclassClosure.api.ts` | Modified | banner shape; count → Link |
| FE `IClassSettingsBody.tsx` | Modified | remove table from sub-tab |
| FE `App.tsx` + new `ClosurePendingPage.tsx` | New/Modified | gated route + page |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| FE banner loses counts (202 has no result) | High | Reword banner to "encolada"; pending-list polling shows drain |
| Multi-instance concurrent backfill | Med | `PgAdvisoryLock('iclass-closure-backfill')` distinct key |
| Shared `closureIngest` (cron + backfill) | Low | `IngestClosedServiceOrders` is stateless; lock prevents self-overlap |
| New page permission | Low | Gate route with `iclass.manage` via `RequirePermission` |

## Rollback Plan

Revert the route to `200 await execute()`, drop `BackfillScheduler` wiring, and restore `ClosureProgressTable` inside the Procesamiento sub-tab + plain-text count. No schema/migration to undo.

## Dependencies

- Existing `PgAdvisoryLock`, `TriggerResult`, `BackfillClosedServiceOrders` instance, FE `RequirePermission` / `iclass.manage`.

## Success Criteria

- [ ] `POST /closure/backfill` returns 202 `{queued:true}` / `{queued:false, reason:'already-running'}` / 503 when null — no timeout.
- [ ] Concurrent calls: second returns `already-running`; advisory lock blocks cross-instance overlap.
- [ ] FE banner reflects queued/in-progress; backfill no longer renders counts.
- [ ] `ClosurePendingPage` renders the table at the gated route; count is a `<Link>`; table removed from the sub-tab.
- [ ] BE + FE tests green (TDD).
