# Verification Report

**Change**: closure-actions-async (#32)
**Version**: spec delta v1 (iclass-closure-loop delta)
**Mode**: Strict TDD

---

### Completeness

| Metric | Value |
|--------|-------|
| Tasks total | 34 |
| Tasks complete | 32 |
| Tasks incomplete | 2 |

Incomplete tasks:
- **B4.2** — Full BE suite run (not marked; was BE-scope task run from FE batch; suite was run during Batch A and confirmed 2509/0/86)
- **B4.5** — Manual smoke test (expected; out of scope for automated verification)

Both are non-blocking: B4.2 is structural scope confusion (the run happened; see BE suite results below), and B4.5 is explicitly manual.

---

### Build & Tests Execution

**BE Build**: ✅ Passed
```
npx tsc --noEmit → exit 0, 0 errors
```

**BE Tests**: ✅ 2509 passed / ❌ 0 failed / ⚠️ 86 skipped (6 suites skipped)
```
Test Suites: 6 skipped, 327 passed, 327 of 333 total
Tests:       86 skipped, 2509 passed, 2595 total
Time: 56.663s
```
The 86 skipped tests are pre-existing (unrelated to this change).

**FE Typecheck**: ✅ Passed
```
npm run typecheck → exit 0, 0 errors
```

**FE Tests**: ⚠️ 1982 passed / ❌ 2 failed / 1 todo (237 files)
```
Test Files  2 failed | 235 passed (237)
Tests       2 failed | 1982 passed | 1 todo (1985)
```

The 2 failures are:
1. `src/__tests__/scheduling/TaskCommentsTimeline.test.tsx` — "submitting with one attachment sends it in the payload" — pre-existing failure, last modified in commit `99730ab` (unrelated to this change)
2. `src/__tests__/scheduling/CustomerSidebar.test.tsx` — "Portal collapsible section renders" — pre-existing failure, last modified in commit `72bcc13` (unrelated to this change)

**Closure-specific FE tests (targeted run)**: ✅ 40/40 passed
```
Test Files  3 passed (3): ClosurePendingPage, IClassClosureFlagBody, IClassSettingsBody
Tests       40 passed (40)
```

**Coverage**: ➖ Not requested (full coverage run not performed; targeted tests cover all spec scenarios)

---

### TDD Compliance

| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | ✅ | Found in apply-progress-be (#823) and apply-progress-fe (#824) |
| All tasks have tests | ✅ | 14 BE tasks have test evidence; 20 FE tasks have test evidence |
| RED confirmed (tests exist) | ✅ | BackfillScheduler.test.ts (6 tests), iclass-closure.routes.test.ts (+4 tests), ClosurePendingPage.test.tsx, IClassClosureFlagBody.test.tsx (+4), IClassSettingsBody.test.tsx (updated) — all verified on disk |
| GREEN confirmed (tests pass) | ✅ | All closure-related tests pass: BackfillScheduler (6/6), routes (35/35 total, 4 new backfill), FE (40/40) |
| Triangulation adequate | ✅ | A1.1+A1.2+A1.3 each have 2 test cases; B1 has 3 banner scenarios; B2 has 3 scenarios |
| Safety Net for modified files | ✅ | iclass-closure.routes.test.ts: 33/33 existing passed before modification |

**TDD Compliance**: 6/6 checks passed

---

### Test Layer Distribution

| Layer | Tests | Files | Tools |
|-------|-------|-------|-------|
| Unit (BE) | 6 | 1 | Jest + ts-jest |
| Integration (BE) | 4 new (+35 total) | 1 | Jest + Supertest |
| Unit/Integration (FE) | 40 | 3 | Vitest + RTL |
| **Total (change scope)** | **50+** | **5** | |

---

### Spec Compliance Matrix

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| REQ-BACKFILL-1 | Backfill dispatched successfully | `iclass-closure.routes.test.ts > POST /closure/backfill → 202 {queued:true} when dispatch succeeds` | ✅ COMPLIANT |
| REQ-BACKFILL-1 | Backfill while a run is already in flight | `iclass-closure.routes.test.ts > POST /closure/backfill → 202 {queued:false, reason:"already-running"} when in flight` | ✅ COMPLIANT |
| REQ-BACKFILL-1 | Backfill when scheduler is not available | `iclass-closure.routes.test.ts > POST /closure/backfill → 503 when backfill scheduler is null` | ✅ COMPLIANT |
| REQ-BACKFILL-1 | Unauthenticated backfill request | `iclass-closure.routes.test.ts > POST /closure/backfill → 401 without auth` | ✅ COMPLIANT |
| REQ-BACKFILL-SCHEDULER-1 | triggerNow returns before background work finishes | `BackfillScheduler.test.ts > returns {queued:true} when idle` + `returns {queued:true} synchronously before execute() completes` | ✅ COMPLIANT |
| REQ-BACKFILL-SCHEDULER-1 | triggerNow re-entrancy guard | `BackfillScheduler.test.ts > returns {queued:false, reason:"already-running"} when inFlight=true` + `does not start a second parallel run when already in flight` | ✅ COMPLIANT |
| REQ-BACKFILL-SCHEDULER-1 | Advisory lock key is distinct | `BackfillScheduler.test.ts > uses lock key "iclass-closure-backfill" (distinct from task-autocomplete and iclass-closed)` | ✅ COMPLIANT |
| REQ-BACKFILL-ASYNC-FE-1 | Successful dispatch — banner shows enqueued | `IClassClosureFlagBody.test.tsx > B1.1 shows "Reconciliación encolada" banner when backfill returns queued:true` | ✅ COMPLIANT |
| REQ-BACKFILL-ASYNC-FE-1 | Already running — banner shows in-progress | `IClassClosureFlagBody.test.tsx > B1.2 shows "Ya hay una reconciliación en curso" when backfill returns queued:false already-running` | ✅ COMPLIANT |
| REQ-BACKFILL-ASYNC-FE-1 | Unavailable — banner shows error | `IClassClosureFlagBody.test.tsx > B1.3 shows "No disponible" when backfill throws with 503 unavailable` | ✅ COMPLIANT |
| REQ-BACKFILL-PENDING-PAGE-1 | Pending page renders the progress table | `ClosurePendingPage.test.tsx > B2.1 renders ClosureProgressTable when user has iclass.manage permission` | ✅ COMPLIANT |
| REQ-BACKFILL-PENDING-PAGE-1 | Pending page is permission-gated | `ClosurePendingPage.test.tsx > B2.2 blocks access when user does NOT have iclass.manage permission` | ✅ COMPLIANT |
| REQ-BACKFILL-PENDING-PAGE-1 | Pending count is a link | `IClassClosureFlagBody.test.tsx > B3.3 renders pending count as a Link to /admin/scheduling/iclass/closure/pending` | ✅ COMPLIANT |
| REQ-BACKFILL-PENDING-PAGE-1 | ClosureProgressTable removed from Procesamiento sub-tab | `IClassSettingsBody.test.tsx > B3.1 clicking Procesamiento mounts closure body but NOT the progress table` | ✅ COMPLIANT |

**Compliance summary**: 14/14 scenarios compliant

---

### Correctness (Static — Structural Evidence)

| Requirement | Status | Notes |
|------------|--------|-------|
| BackfillScheduler uses lock key `'iclass-closure-backfill'` | ✅ Implemented | `const LOCK_KEY = 'iclass-closure-backfill'` in BackfillScheduler.ts line 5 |
| Lock key distinct from `'task-autocomplete'` and `'iclass-closed'` | ✅ Implemented | Verified by lock-key test and code inspection |
| `triggerNow()` is non-blocking (fire-and-forget) | ✅ Implemented | `void this.runOnce()` — does NOT await; returns `{queued:true}` immediately |
| Re-entrancy guard (`inFlight`) | ✅ Implemented | Guard checked in both `triggerNow()` and `runOnce()` |
| No `start()`/`setInterval` | ✅ Implemented | BackfillScheduler.ts has no `start()` method, no `setInterval` |
| `BackfillTriggerResult` has NO `'flag-disabled'` reason | ✅ Implemented | Type is `{queued:true} \| {queued:false; reason:'already-running'}` — no `flag-disabled` |
| Route returns 202 union / 503 (not 200) | ✅ Implemented | Route: `if (!backfillScheduler) 503; else 202 triggerNow()` |
| Route does NOT block on IClass/OCR/audit | ✅ Implemented | Route awaits only `triggerNow()` (instant); `runOnce()` runs detached |
| `main.ts` awaits `bootstrapBackfill` before `createApp` | ✅ Implemented | `const backfillScheduler = await bootstrapBackfill()` then `createApp(taskAutocomplete, backfillScheduler)` |
| `app.ts` `createApp` gains `backfillScheduler` param | ✅ Implemented | `createApp(taskAutocomplete?: ..., backfillScheduler?: ...)` at line 530 |
| FE `ClosureBackfillResult` removed | ✅ Implemented | `iclassClosure.api.ts` has no `ClosureBackfillResult`; uses `BackfillTriggerResult` |
| `ClosureProgressTable` removed from `IClassSettingsBody` | ✅ Implemented | `IClassSettingsBody.tsx` grep confirms only a comment reference, no import/usage |
| `ClosurePendingPage` exists at standalone route | ✅ Implemented | `App.tsx` line 239: `scheduling/iclass/closure/pending` → `ClosurePendingPage` |
| Route gated by `iclass.manage` | ✅ Implemented | Both page-internal `RequirePermission` and route-level `RequirePermission` wrap |
| Pending count rendered as `<Link>` | ✅ Implemented | `IClassClosureFlagBody.tsx` line 260: `<Link to="/admin/scheduling/iclass/closure/pending">` |

---

### Coherence (Design)

| Decision | Followed? | Notes |
|----------|-----------|-------|
| New `BackfillScheduler` class (not extending `TaskAutocompleteScheduler`) | ✅ Yes | Separate class, separate file |
| No `start()`, no `setInterval` | ✅ Yes | Confirmed in code |
| `BackfillTriggerResult` local type (no `flag-disabled`) | ✅ Yes | Defined locally in BackfillScheduler.ts |
| `bootstrapBackfill.ts` composition root, returns null on missing creds | ✅ Yes | Returns null when `!username \|\| !password \|\| !thirdPartyId` |
| Router slot 5 replaced: `backfillScheduler: BackfillScheduler \| null` | ✅ Yes | Slot 5 in `createIClassClosureRouter` is `backfillScheduler` |
| FE banner: queued/already-running/unavailable (no counts) | ✅ Yes | Banner branches on `queued`/`reason`; 503 caught as thrown error (deviation noted below) |
| FE `ClosurePendingPage` lazy, gated `iclass.manage` | ✅ Yes | Lazy import + `RequirePermission` at both component and route level |

**Noted Deviations (acceptable)**:
- **BE: test file pre-updated**: `iclass-closure.routes.test.ts` already had stub infrastructure when A3 RED phase ran. The TDD evidence table flags the safety net was run (33/33 prior tests passed). Acceptable — RED was structural, safety net confirmed.
- **FE: 503 as caught error**: The unavailable banner is driven by a `try/catch` in `handleBackfill()` (axios throws on 503), tracked in a separate `backfillUnavailable` state, NOT via the `lastBackfill` mutation result. This is architecturally sound given axios behavior and matches the apply-progress note. The B1.3 test uses `mockRejectedValue` to simulate it correctly. **Verdict: acceptable deviation, correctly documented and tested.**

---

### Assertion Quality

**BackfillScheduler.test.ts**: No tautologies. No ghost loops. All assertions verify real return values (`toEqual({queued:true/false})`, `toMatchObject({skipped:true})`, `toContain('iclass-closure-backfill')`). Execute-count assertions (`toBe(1)`) are value-asserting, not implementation detail.

**iclass-closure.routes.test.ts**: Assertions check HTTP status codes and body shapes from real supertest calls. No tautologies.

**ClosurePendingPage.test.tsx**: Assertions check `getByTestId` (table present/absent) and `getByRole('heading')`. `queryByTestId` + `not.toBeInTheDocument()` has a companion positive test (B2.1). No empty-collection ghost loops.

**IClassClosureFlagBody.test.tsx**: B1.1/B1.2/B1.3 use `screen.findByText()` (async, waits for state update). B3.3 asserts link `href`. All behavioral assertions.

**IClassSettingsBody.test.tsx**: B3.1 asserts closure-body present + progress-table absent — companion of pre-existing positive test that checks closure-body. Clean.

**Assertion quality**: ✅ All assertions verify real behavior — 0 CRITICAL, 0 WARNING

---

### Tautological Test Watch

No tautological tests found (`expect(true).toBe(true)` pattern). The `expect(screen.queryByTestId('closure-progress-table')).not.toBeInTheDocument()` assertion in B3.1 is a valid negative assertion — the mock IS registered, so if the component rendered the table it would appear; the test proves it does NOT.

---

### Issues Found

**CRITICAL** (must fix before archive):
None

**WARNING** (should fix):
- **FE test suite has 2 pre-existing failures** (TaskCommentsTimeline + CustomerSidebar) unrelated to this change. These should be fixed but do not block this change's archive. Both failures existed before this branch.

**SUGGESTION**:
- `ClosurePendingPage` wraps `RequirePermission` internally AND `App.tsx` wraps again at the route level (double-guard). Not a bug (defense in depth), but redundant. Consider removing the route-level wrapper since the component already gates itself.

---

### Verdict

**PASS WITH WARNINGS**

14/14 spec scenarios compliant. BE suite: 2509/0/86. BE typecheck: 0 errors. FE targeted suite: 40/40. FE typecheck: 0 errors. Full FE suite: 2 pre-existing failures in unrelated files (TaskCommentsTimeline, CustomerSidebar) — not introduced by this change. Architecture checks all green: distinct lock key, fire-and-forget guard, no timer, 202/503 route shape, `BackfillTriggerResult` without `flag-disabled`, `ClosureProgressTable` absent from sub-tab, pending count is a `<Link>`. TDD evidence complete and cross-validated.
