# Verification Report — network-node-task (#29)

**Change**: `network-node-task`
**Date**: 2026-06-08
**Mode**: Strict TDD
**Artifact Store**: Hybrid

---

## Completeness

| Metric | Value |
|--------|-------|
| Tasks total (Batch A) | 17 |
| Tasks complete (Batch A) | 17 |
| Tasks incomplete (Batch A) | 0 |
| Tasks total (Batch B) | 12 |
| Tasks complete (Batch B) | 12 |
| Tasks incomplete (Batch B) | 0 |
| **Grand total** | **29/29** |

> **Note**: The tasks.md file shows Batch B phases (B1–B6) with unchecked checkboxes `[ ]`. However, the apply-progress-fe engram artifact explicitly records all 12 B-tasks as `✅` complete with final totals of 234 test files, 1947 tests, 0 regressions. The tasks.md was not updated to reflect completion — this is a documentation gap, **not** an implementation gap. All code and tests exist and pass.

---

## Build & Tests Execution

### Backend

**TypeCheck (`npx tsc --noEmit`)**: ✅ 0 errors

**Tests (`npx jest --runInBand`)**: ✅ 2474 passed / 0 failed / 86 skipped
```
Test Suites: 6 skipped, 322 passed, 322 of 328 total
Tests:       86 skipped, 2474 passed, 2560 total
Time: 54.79s
```

**Coverage**: Not collected in this run (not configured as mandatory gate)

### Frontend

**TypeCheck (`npm run typecheck`)**: ✅ 0 errors

**Tests (`npx vitest run`)**: ✅ 1946 passed / 0 failed / 1 todo
```
Test Files  234 passed (234)
Tests  1946 passed | 1 todo (1947)
Duration: 279.20s
```

**Coverage**: Not collected in this run

---

## Flaky Test Confirmation

`TaskCommentsTimeline.test.tsx` — confirmed pre-existing and NOT flaky in the context of this change.
- **Full suite run**: 0 failures — test passes as part of the complete run.
- **Isolated run (`npx vitest run "TaskCommentsTimeline"`)**: 18/18 pass.

The apply-progress-fe note about `body:''` assertion failures referenced a body-empty assertion pattern in the test, but the current implementation passes cleanly in both modes. The pre-existing behavior described is benign. **CONFIRMED: no flaky failure attributable to this change.**

---

## TDD Compliance

| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | ✅ | Found in apply-progress-be, all 17 tasks covered in TDD Cycle Evidence table |
| All BE tasks have tests | ✅ | 17/17 tasks have test files confirmed in codebase |
| RED confirmed (tests exist) | ✅ | 6 new test files verified: `migration.network_node_task.test.ts`, `scheduling.dto.kind.test.ts`, `CreateTask.test.ts` (network cases), `PrismaSchedulingRepository.networkNodeTask.test.ts`, `SendTaskToIClass.network.test.ts`, `scheduling.network.routes.test.ts` |
| GREEN confirmed (tests pass) | ✅ | All pass on execution — 2474 total, 0 failed |
| Triangulation adequate | ✅ | Multiple scenarios per requirement covered (4-9 cases per spec req) |
| Safety Net for modified files | ✅ | Existing tests updated with `kind: 'customer'` to maintain regression coverage |
| FE TDD evidence | ✅ | apply-progress-fe documents RED → GREEN per B-phase for all 12 tasks |

**TDD Compliance**: 7/7 checks passed

---

## Test Layer Distribution

### Backend
| Layer | Tests | Files | Tools |
|-------|-------|-------|-------|
| Unit | ~27 (new, network-specific) | 6 | Jest |
| Integration | ~10 (routes supertest) | 1 | Jest + supertest |
| **Total new** | **~37** | **7** | |

### Frontend
| Layer | Tests | Files | Tools |
|-------|-------|-------|-------|
| Integration (RTL) | 26 | 4 | Vitest + Testing Library |
| **Total new** | **26** | **4** | |

---

## Spec Compliance Matrix

### scheduling/spec.md (8 scenarios)

| Requirement | Scenario | Test File | Test Name | Result |
|-------------|----------|-----------|-----------|--------|
| REQ-KIND-1 | Network task created successfully | `scheduling.network.routes.test.ts` | `returns 201 with kind=network and networkSiteId` | ✅ COMPLIANT |
| REQ-KIND-1 | Customer task payload regression | `CreateTask.test.ts` (existing) + A7.2 regression run | customer path in `jest --runInBand` | ✅ COMPLIANT |
| REQ-KIND-2 | Missing networkSiteId returns 400 | `scheduling.network.routes.test.ts` | `returns 400 when networkSiteId is missing` | ✅ COMPLIANT |
| REQ-KIND-2 | Network+customerId combo rejected | `scheduling.dto.kind.test.ts` | `network + customerId combo is rejected` | ✅ COMPLIANT |
| REQ-KIND-3 | Non-existent networkSiteId returns 404 | `scheduling.network.routes.test.ts` | `returns 404 when networkSiteId does not exist` | ✅ COMPLIANT |
| REQ-SHAPE-2 | Network task exposes kind and site fields | `scheduling.network.routes.test.ts` | `response contains kind, networkSiteId, null customerId` | ✅ COMPLIANT |
| REQ-SHAPE-2 | Customer task has kind='customer', null network fields | `PrismaSchedulingRepository.networkNodeTask.test.ts` + regression suite | toTask mapping tests | ✅ COMPLIANT |
| REQ-VAL-1 | Customer schema rejects missing contract | `scheduling.dto.kind.test.ts` | `customer without contractId is rejected` | ✅ COMPLIANT |
| REQ-VAL-1 | Network schema rejects missing networkSiteId | `scheduling.dto.kind.test.ts` | `network without networkSiteId is rejected` | ✅ COMPLIANT |
| REQ-REF-NETWORK-1 | Full error chain for non-existent networkSiteId | `scheduling.network.routes.test.ts` | `returns 404 ... code: 'NETWORK_SITE_NOT_FOUND'` | ✅ COMPLIANT |

### iclass-integration/spec.md (8 scenarios)

| Requirement | Scenario | Test File | Test Name | Result |
|-------------|----------|-----------|-----------|--------|
| REQ-NODE-DISPATCH-1 | Network task dispatched with node-derived fields | `SendTaskToIClass.network.test.ts` | `dispatches network task with substituted fields` | ✅ COMPLIANT |
| REQ-NODE-DISPATCH-1 | Customer task dispatch unchanged | `SendTaskToIClass.network.test.ts` | `customer task still calls listNodes() city-match` | ✅ COMPLIANT |
| REQ-NODE-DISPATCH-2 | Network task with complete site data passes validation | `SendTaskToIClass.network.test.ts` | `network task with complete site data passes required-field validation` | ✅ COMPLIANT |
| REQ-NODE-DISPATCH-2 | Substitution runs before null customerName check | `SendTaskToIClass.network.test.ts` | `network task with null customerName passes because substitution uses networkSiteName` | ✅ COMPLIANT |
| REQ-NODE-DISPATCH-3 | Site without iclassNodeCode uses 'NETWORK' fallback | `SendTaskToIClass.network.test.ts` | `iclassNodeCode=null falls back to NETWORK for customerCode and nodeCode` | ✅ COMPLIANT |
| REQ-PORT-1 | nodeCode override bypasses listNodes lookup | `SendTaskToIClass.network.test.ts` | `listNodes() is NOT called for network tasks` | ✅ COMPLIANT |
| REQ-PORT-1 | Absent nodeCode falls through to city-match | `SendTaskToIClass.network.test.ts` | `customer task still calls listNodes() city-match` | ✅ COMPLIANT |
| REQ-PORT-1 | soType passed through unchanged | Covered by both dispatch tests (soType: 'MANTENIMIENTO' assertion) | `dispatches network task with substituted fields` | ✅ COMPLIANT |

**Compliance summary**: 18/18 scenarios compliant (16 spec scenarios + 2 additional coverage scenarios)

---

## Correctness (Static — Structural Evidence)

| Requirement | Status | Notes |
|-------------|--------|-------|
| REQ-KIND-1: Network task creates with null customer/contract | ✅ Implemented | `CreateTask.ts:24-29` branches by `kind`, skips customer/contract validation |
| REQ-KIND-2: Zod discriminated union rejects invalid combos | ✅ Implemented | `scheduling.dto.ts:79-100` CustomerTask + NetworkTask branches |
| REQ-KIND-3: ReferenceNotFoundError for missing networkSite | ✅ Implemented | `CreateTask.ts:28` throws `ReferenceNotFoundError('networkSite', siteId)` |
| REQ-SHAPE-2: kind/networkSiteId/networkSiteName on entity | ✅ Implemented | `domain/entities/scheduling.ts` confirmed by migration + toTask mapping |
| REQ-VAL-1: discriminatedUnion on 'kind' | ✅ Implemented | `z.discriminatedUnion('kind', [CustomerTask, NetworkTask]).superRefine(dateRangeRefine)` |
| REQ-REF-NETWORK-1: ReferenceKind includes 'networkSite' | ✅ Implemented | `domain/errors/scheduling.ts:3` — 'networkSite' in ReferenceKind union |
| REQ-REF-NETWORK-1: REFERENCE_TO_CODE mapping | ✅ Implemented | `scheduling.routes.ts:61` — `networkSite: 'NETWORK_SITE_NOT_FOUND'` |
| REQ-NODE-DISPATCH-1: field substitution in dispatchTaskToIClass | ✅ Implemented | `dispatchTaskToIClass.ts:27-28` NETWORK_PHONE + NETWORK_CUSTOMER_CODE constants |
| REQ-NODE-DISPATCH-2: required-field check uses substituted values | ✅ Implemented | `SendTaskToIClass.ts:118-133` substitutedValues block for network path |
| REQ-NODE-DISPATCH-3: iclassNodeCode null → 'NETWORK' fallback | ✅ Implemented | `SendTaskToIClass.ts:137` `networkSite?.iclassNodeCode ?? NETWORK_CUSTOMER_CODE` |
| REQ-PORT-1: nodeCode override in CreateServiceOrderInput | ✅ Implemented | `nodeCode?: string` field in IClassPort, IClassClient uses it at line 301 |
| Architecture: CreateTask imports only domain/application | ✅ Verified | `CreateTask.ts` imports only `@domain/*` and `./taskActivityActor` |
| Architecture: migration additive with kind default 'customer' | ✅ Verified | Migration SQL confirmed by `migration.network_node_task.test.ts` |
| Architecture: NetworkSiteRepository reused (not new port) | ✅ Verified | `app.ts` wires `PrismaNetworkSiteRepository` into CreateTask + SendTaskToIClass |

---

## Coherence (Design Match)

| Decision | Followed? | Notes |
|----------|-----------|-------|
| D1: `kind` as plain String @default("customer") | ✅ Yes | No Prisma enum, column default backfills existing rows |
| D2: networkSiteId onDelete SetNull | ✅ Yes | Matches customerId/contractId pattern |
| D3: Branch in CreateTask.execute by kind (one use case) | ✅ Yes | `if (data.kind === 'network')` gate at line 24 |
| D4: z.discriminatedUnion('kind', [...]) | ✅ Yes | Exact pattern from design contract |
| D5: Explicit iclassNodeCode → nodeCode override, skip city-node lookup | ✅ Yes | `SendTaskToIClass.ts:136-137`, listNodes never called for network |
| D6: Phone placeholder "0000000000" as NETWORK_PHONE constant | ✅ Yes | `dispatchTaskToIClass.ts:27` |
| D7: Reuse existing NetworkSiteRepository (no new port) | ✅ Yes | `findById` injected into CreateTask and SendTaskToIClass |
| File changes match design table | ✅ Yes | All 13 listed BE files modified as specified |
| FE: CreateTaskModal RED toggle + NodeSelector + canSave branch | ✅ Yes | apply-progress-fe confirms all UI components |
| FE: NetworkSite form iclassNodeCode field | ✅ Yes | `NetworkSitesPage.iclassNodeCode.test.tsx` 4/4 pass |
| FE: Kanban + TableView RED badge | ✅ Yes | `NetworkBadge.test.tsx` 5/5 pass |

---

## Documented Deviation Analysis

**Deviation**: `kind` and `networkSiteId` are OPTIONAL (`kind?: 'customer'|'network'`, `networkSiteId?: string|null`) on `CreateTaskInput` instead of required.

**Root cause**: `CreateTaskInput extends Omit<ScheduledTask, ...>` — if `kind` and `networkSiteId` were required on `ScheduledTask`, adding them to `CreateTaskInput` as required would break all ~30+ existing callers that don't yet pass these fields.

**Mechanism**: The fields are added to the `Omit` list and re-declared as optional. This allows existing callers (GR ingest, test fixtures, other use cases) to continue working without changes.

**Verdict**: ✅ **ACCEPTABLE** — this is a well-reasoned retro-compatibility decision. The DTO layer (`CreateTaskSchema`) still enforces required `kind` on all HTTP-sourced tasks via Zod discriminated union. The optional port interface only affects internal callers, which default to `'customer'` behavior via `if (data.kind === 'network')` branching (undefined is falsy → falls to customer path). The invariant is preserved at the boundary that matters (HTTP entry point).

---

## Assertion Quality Audit

| File | Line | Assertion | Issue | Severity |
|------|------|-----------|-------|----------|
| `NodeSelector.test.tsx` | ~101 | `expect(document.body).toBeTruthy()` | `document.body` is always truthy — tautology for the loading state test. The test does not verify any loading indicator UI. Also, `vi.doMock` after top-level `import` does not re-wire the already-imported module in the same test file context, so this test cannot actually exercise the loading code path. | WARNING |

**Assertion quality**: 0 CRITICAL, 1 WARNING

The loading state test in `NodeSelector.test.tsx` is a smoke test that proves nothing about the actual loading UI. It should be rewritten to use a `vi.mock` hoisting pattern with a loading-state variant, or be removed if the component has no loading indicator to test.

---

## Issues Found

**CRITICAL** (must fix before archive):
None.

**WARNING** (should fix):
1. **tasks.md Batch B checkboxes not updated** — B1–B6 tasks remain `[ ]` (unchecked) in `openspec/changes/network-node-task/tasks.md`. The implementation is complete and all tests pass, but the task checklist doesn't reflect reality. Fix: check off all B-phase tasks in tasks.md before archiving.
2. **NodeSelector loading state test is a tautology** (`NodeSelector.test.tsx` line ~101, `expect(document.body).toBeTruthy()`). The `vi.doMock` call does not work after top-level imports are already resolved — the hook mock isn't re-wired for this test case. The assertion always passes regardless of component behavior. Fix: either use a `beforeAll/vi.mock` hoisting pattern with a separate describe block for loading state, or remove the test.

**SUGGESTION**:
1. The `NetworkBadge.test.tsx` KanbanCard tests render the card without wrapping in `MemoryRouter`. If `KanbanCard` ever adds a link internally, tests will fail. Low risk currently.
2. Design open question about `customerCode` for network SO (iclassNodeCode vs fixed "NETWORK" char limit/uniqueness) remains unresolved as a comment in `design.md`. No action required for archive — it's documented.

---

## Verdict

**PASS WITH WARNINGS**

All 18 spec scenarios are compliant. Both test suites are fully green (BE: 2474/0, FE: 1946/0). Both typechecks are clean. The flaky test concern is confirmed non-issue — `TaskCommentsTimeline` passes in both full-suite and isolated runs. The documented deviation (optional kind/networkSiteId on CreateTaskInput) is architecturally sound. Two warnings: tasks.md Batch B checkbox hygiene and a trivially weak NodeSelector loading test. Neither blocks archive.
