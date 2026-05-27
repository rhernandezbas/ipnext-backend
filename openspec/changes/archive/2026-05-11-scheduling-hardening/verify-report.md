# Verify Report: Scheduling Module Hardening

**Verifier**: sdd-verify sub-agent (independent, blind review)
**Date**: 2026-05-11
**Verdict**: PASS WITH WARNINGS

---

## Section 1 — Completeness

All **26 tasks** are marked `[x]`. No unchecked items.

| Phase | Count | Status |
|-------|-------|--------|
| Phase 1 — Foundation | 3 | All `[x]` |
| Phase 2 — TDD: Auth | 6 | All `[x]` |
| Phase 3 — TDD: Validation | 6 | All `[x]` |
| Phase 4 — TDD: Adapter bugfixes | 6 | All `[x]` |
| Phase 5 — Verification | 4 | All `[x]` |
| Phase 6 — Coordination | 1 | `[x]` (tracked, no code) |

---

## Section 2 — Spec Compliance Matrix

32 REQ-* IDs total.

### Authentication (REQ-AUTH-1..8)

| REQ | Description | Status | Evidence |
|-----|-------------|--------|----------|
| REQ-AUTH-1 | GET / → 401 without cookie | ✅ | `scheduling.routes.test.ts:57-62` |
| REQ-AUTH-2 | GET /:id → 401 without cookie | ✅ | `scheduling.routes.test.ts:64-69` |
| REQ-AUTH-3 | POST / → 401 without cookie | ✅ | `scheduling.routes.test.ts:71-76` |
| REQ-AUTH-4 | PUT /:id → 401 without cookie | ✅ | `scheduling.routes.test.ts:78-83` |
| REQ-AUTH-5 | DELETE /:id → 401 without cookie | ✅ | `scheduling.routes.test.ts:85-90` |
| REQ-AUTH-6 | PATCH /:id/status → 401 without cookie | ✅ | `scheduling.routes.test.ts:92-97` |
| REQ-AUTH-7 | Invalid token → 401 | ✅ | `authMiddleware.test.ts:63-74` — covered at middleware unit level |
| REQ-AUTH-8 | Valid token → handler called | ✅ | `authMiddleware.test.ts:50-61` — covered at middleware unit level |

**Note on REQ-AUTH-7/8**: `RejectingJwtAuthAdapter` is defined in `scheduling.routes.test.ts` but **never used** in any test case. This is dead test code. The scenarios are covered by the existing `authMiddleware.test.ts`. Not a CRITICAL (behavior is tested), but the unused adapter is a cleanup opportunity.

### List Tasks (REQ-LIST-1..3)

| REQ | Description | Status | Evidence |
|-----|-------------|--------|----------|
| REQ-LIST-1 | GET / returns 200 + array | ✅ | `scheduling.routes.test.ts:103-113` |
| REQ-LIST-2 | GET / empty → 200 + `[]` | ⚠️ | Happy-path test uses pre-seeded repo (6 tasks). No test for empty case. |
| REQ-LIST-3 | Every item includes `projectName` | ⚠️ | No explicit assertion on `projectName` in list response. Pre-seeded tasks have no `projectName` set (InMemory fixture has no `projectName` field on tasks 1-6). |

### Get Task by ID (REQ-GET-1..2)

| REQ | Description | Status | Evidence |
|-----|-------------|--------|----------|
| REQ-GET-1 | GET /:id → 200 with task | ⚠️ | No dedicated GET /:id test exists. Only DELETE and PUT by ID tests use existing IDs. |
| REQ-GET-2 | GET /:id → 404 when not found | ⚠️ | No test for this case. |

### Create Task (REQ-CREATE-1..8)

| REQ | Description | Status | Evidence |
|-----|-------------|--------|----------|
| REQ-CREATE-1 | Valid body → 201 | ✅ | `scheduling.routes.test.ts:116-144` |
| REQ-CREATE-2 | Missing `title` → 400 | ✅ | `scheduling.routes.test.ts:230-240` |
| REQ-CREATE-3 | Invalid `estimatedHours` type → 400 | ✅ | `scheduling.routes.test.ts:242-251` |
| REQ-CREATE-4 | Invalid `status` → 400 | ✅ | `scheduling.routes.test.ts:253-262` |
| REQ-CREATE-5 | Invalid `priority` → 400 | ✅ | `scheduling.routes.test.ts:264-273` |
| REQ-CREATE-6 | Invalid `category` → 400 | ✅ | `scheduling.routes.test.ts:275-284` |
| REQ-CREATE-7 | Nullable fields MAY be `null` | ✅ | `POST` happy-path uses `null` for nullable fields; zod schema has `.nullable()` |
| REQ-CREATE-8 | Nullable fields MAY be strings | ✅ | `scheduling.routes.test.ts:119-143` passes non-null strings for all nullable fields |

### Update Task (REQ-UPDATE-1..4)

| REQ | Description | Status | Evidence |
|-----|-------------|--------|----------|
| REQ-UPDATE-1 | Valid partial body → 200 | ✅ | `scheduling.routes.test.ts:147-156` |
| REQ-UPDATE-2 | PUT /:id → 404 when not found | ✅ | `scheduling.routes.test.ts:158-165` |
| REQ-UPDATE-3 | Invalid `estimatedHours` type → 400 | ✅ | `scheduling.routes.test.ts:290-299` |
| REQ-UPDATE-4 | Invalid `status` → 400 | ✅ | `scheduling.routes.test.ts:301-310` |

### Update Task Status (REQ-STATUS-1..7)

| REQ | Description | Status | Evidence |
|-----|-------------|--------|----------|
| REQ-STATUS-1 | Valid status → 200 | ✅ | `scheduling.routes.test.ts:169-178` |
| REQ-STATUS-2 | `"done"` → 400 | ✅ | `scheduling.routes.test.ts:316-325` |
| REQ-STATUS-3 | Empty body → 400 | ✅ | `scheduling.routes.test.ts:327-336` |
| REQ-STATUS-4 | `completed` auto-sets `completedAt` | ⚠️ | No route test. Logic exists in InMemory and Prisma adapters but not asserted at HTTP level. |
| REQ-STATUS-5 | Non-completed doesn't overwrite `completedAt` | ⚠️ | No test for this case at any layer. |
| REQ-STATUS-6 | PATCH /:id/status → 404 when not found | ✅ | `scheduling.routes.test.ts:180-188` |
| REQ-STATUS-7 | Response includes `projectName` from linked project | ✅ | Route test at `scheduling.routes.test.ts:342-392` (InMemory) + `PrismaSchedulingRepository.toTask.test.ts:72-98` (unit). Prisma `include: { project: true }` confirmed at line 126. |

### Delete Task (REQ-DELETE-1..2)

| REQ | Description | Status | Evidence |
|-----|-------------|--------|----------|
| REQ-DELETE-1 | Existing task → 204 | ✅ | `scheduling.routes.test.ts:192-197` |
| REQ-DELETE-2 | Non-existent task → 404 | ✅ | `scheduling.routes.test.ts:199-205` |

### Response Shape (REQ-SHAPE-1..2)

| REQ | Description | Status | Evidence |
|-----|-------------|--------|----------|
| REQ-SHAPE-1 | Every task response includes `projectName` | ⚠️ | Only PATCH /:id/status test asserts `projectName`. GET list, GET by id, POST, PUT do not assert `projectName` field presence. |
| REQ-SHAPE-2 | Task object field structure (table) | ✅ | Domain entity `scheduling.ts` declares all fields per table. tsc confirms type integrity. |

### Nullable Fields (REQ-NULL-1..9)

| REQ | Description | Status | Evidence |
|-----|-------------|--------|----------|
| REQ-NULL-1 | `description` is `string \| null` | ✅ | Entity relaxed; `toTask` uses `?? null`; `CreateTaskSchema` uses `.nullable()` |
| REQ-NULL-2 | `assignedTo` is `string \| null` | ✅ | Same as above |
| REQ-NULL-3 | `assignedToId` is `string \| null` | ✅ | Same as above |
| REQ-NULL-4 | `address` is `string \| null` | ✅ | Same as above |
| REQ-NULL-5 | `notes` is `string \| null` | ✅ | Same as above |
| REQ-NULL-6 | `coordinates` is `{lat,lng} \| null` | ✅ | Pre-existing; unchanged |
| REQ-NULL-7 | `clientId`/`clientName` MAY be `null` | ✅ | Pre-existing; unchanged |
| REQ-NULL-8 | `projectId`/`projectName` MAY be `null` | ✅ | `toTask` maps both with `?? null` |
| REQ-NULL-9 | Prisma adapter MUST NOT return `undefined` | ✅ | `PrismaSchedulingRepository.toTask.test.ts:8-38` unit tests; zero `?? undefined` in file |

### Validation Schemas (REQ-VAL-1..3)

| REQ | Description | Status | Evidence |
|-----|-------------|--------|----------|
| REQ-VAL-1 | `CreateTaskSchema` covers all required fields | ✅ | `src/application/dto/scheduling.dto.ts:9-27` — all required + nullable fields present |
| REQ-VAL-2 | `UpdateTaskSchema` is partial of `CreateTaskSchema` | ✅ | `CreateTaskSchema.partial()` at line 29 |
| REQ-VAL-3 | `UpdateStatusSchema` accepts only 4 valid values | ✅ | `z.object({ status: TaskStatusSchema })` at line 31 |

### Dependency Inversion (REQ-DIP-1..2)

| REQ | Description | Status | Evidence |
|-----|-------------|--------|----------|
| REQ-DIP-1 | No `@infrastructure/*` imports in `application/` | ✅ | `rg @infrastructure src/application` → zero matches |
| REQ-DIP-2 | `createSchedulingRouter` receives `authProvider` as parameter | ✅ | Function signature at `scheduling.routes.ts:13-21`; `authAdapter` passed from `app.ts:515` |

**Note on REQ-DIP-2**: `scheduling.routes.ts` imports `JwtAuthAdapter` directly for the type annotation of the `authProvider` parameter (mirroring `clients.routes.ts` pattern). A port interface `AuthProvider` exists at `src/domain/ports/AuthProvider.ts` and would be the purer type. This is pre-existing pattern debt, not introduced by this change.

---

### Compliance Summary

- ✅ Implemented with test evidence: **22**
- ⚠️ Implemented but test coverage unclear or thin: **8**
- ❌ Missing or incorrect: **0**

---

## Section 3 — Design Coherence

| Check | Result |
|-------|--------|
| `scheduling.dto.ts` in `src/application/dto/` | ✅ Correct location |
| Auth per-route (`router.get('/', auth, handler)`) | ✅ All 5 routes use per-route auth; no `router.use(auth)` |
| No `router.use(auth)` | ✅ Grep confirms zero matches |
| Test uses fake `JwtAuthAdapter` | ✅ `FakeJwtAuthAdapter` in test file |
| DTO imports nothing from `@infrastructure/*` | ✅ Only `import { z } from 'zod'` |
| `app.ts` change is exactly one line | ✅ Diff confirms single line changed at 515 |
| `toTask` exported for testability | ✅ `export function toTask` — enables unit testing |
| `updateTaskStatus` has `include: { project: true }` | ✅ Confirmed at line 126 |

---

## Section 4 — TDD Compliance

**Context**: All changes are uncommitted (working tree only). The git diff confirms what changed vs the previous commits. No commit trail to verify RED→GREEN ordering — the changes arrived as a single working-tree batch.

**What CAN be verified**:
- The test file was modified (git diff shows it) — tests exist alongside implementation
- The apply agent flagged "Phases 2+3 RED merged" — meaning RED tests were not committed before GREEN implementation
- Task 4.2 flagged "InMemory may not truly simulate the bug" — acknowledged, mitigated by `toTask` unit test

**TDD Evidence assessment**:
- 24 tests exist in `scheduling.routes.test.ts` (6 auth + 13 happy-path/404 + 5 validation + 2 status-validation + 1 projectName) — all passing
- 4 tests exist in `PrismaSchedulingRepository.toTask.test.ts` — all passing
- Total 342/342 passing confirms no regressions

**Deviation**: No verifiable RED→GREEN commit ordering (single working-tree batch). This is a process deviation, not a correctness problem — the tests would fail if the implementation were removed.

---

## Section 5 — Execution Evidence

### npm test
```
Test Suites: 63 passed, 63 total
Tests:       342 passed, 342 total
Snapshots:   0 total
Time:        17.752 s
```
✅ 342/342 passing — matches the apply agent's claim exactly.

### tsc --noEmit
```
(no output)
```
✅ Zero type errors. Clean.

### Call site verification
`rg "createSchedulingRouter\(" src` — exactly:
- 1 definition in `src/infrastructure/http/routes/scheduling.routes.ts:13`
- 1 call in `src/infrastructure/http/app.ts:515`
- 2 calls in `src/__tests__/infrastructure/scheduling.routes.test.ts` (test setup, expected)

✅ Correct structure.

---

## Section 6 — Findings Classification

### WARNINGS (non-blocking)

**W-1**: `RejectingJwtAuthAdapter` is dead code in `scheduling.routes.test.ts`
- File: `src/__tests__/infrastructure/scheduling.routes.test.ts:22-27`
- The class is defined but never used in any `describe`/`it` block. REQ-AUTH-7/8 are covered by `authMiddleware.test.ts` which is fine, but the unused class creates confusion.
- Action: Remove `RejectingJwtAuthAdapter` from the scheduling test file, or add at least one `buildApp(false)` test to cover the "invalid token" path at the route integration level.

**W-2**: No HTTP-level tests for REQ-GET-1, REQ-GET-2 (GET /:id with ID)
- File: `src/__tests__/infrastructure/scheduling.routes.test.ts`
- The `GET /api/scheduling/:id` route is implemented and protected by auth, but there is no `describe('GET /api/scheduling/:id')` test block. REQ-GET-1 (200) and REQ-GET-2 (404) have zero route-level test coverage.
- Action: Add test block for `GET /api/scheduling/:id` with happy path + not-found cases.

**W-3**: REQ-STATUS-4 and REQ-STATUS-5 (`completedAt` behavior) not tested at HTTP level
- File: `src/__tests__/infrastructure/scheduling.routes.test.ts`
- The `completedAt` auto-set on `completed` status and preservation on other statuses are not asserted in any test. The logic exists in both adapters but is unverified at the route layer.
- Action: Add assertions in the PATCH `/:id/status` happy-path test: `expect(res.body.completedAt).toBeTruthy()` when status is `completed`.

**W-4**: REQ-LIST-3 and REQ-SHAPE-1 (`projectName` in list/create/update responses) not asserted
- File: `src/__tests__/infrastructure/scheduling.routes.test.ts`
- Only the PATCH /:id/status test asserts `projectName`. GET list, POST create, and PUT update happy-path tests do not assert the `projectName` field presence.
- Action: Add `expect(res.body.projectName).toBeDefined()` (or null check) in GET, POST, PUT tests.

**W-5**: REQ-DIP-2 type annotation uses concrete `JwtAuthAdapter` instead of `AuthProvider` port
- File: `src/infrastructure/http/routes/scheduling.routes.ts:9`
- `authProvider: JwtAuthAdapter` parameter type uses the concrete class; `AuthProvider` interface exists at `src/domain/ports/AuthProvider.ts` and would be the purer type. This mirrors the pre-existing `clients.routes.ts` pattern (same debt), so it is not a regression introduced by this change.
- Action: Follow-up tech debt — use `AuthProvider` interface for `authProvider` parameter type in all route files.

**W-6**: Task description labels REQ-NULL-5 as covering `description` (task 4.1) but spec REQ-NULL-5 is `notes`
- This is a documentation inconsistency in `tasks.md`. Both fields are correctly implemented and tested.
- Action: No code change needed; label is misleading in tasks.md only.

### SUGGESTIONS (nice-to-have)

**S-1**: `REQ-LIST-2` (empty array) has no test. The pre-seeded InMemory repo always returns 6 tasks, making this scenario untestable with `buildApp()`. A simple test with a freshly constructed empty InMemory repo would cover this.

**S-2**: `completedAt` returned in `updateTaskStatus` for Prisma is not casted to ISO string (the `toTask` function casts `completedAt instanceof Date ? row.completedAt.toISOString() : row.completedAt` — correct), but Prisma returns `Date` objects. The cast is correct; no action needed.

---

## Section 7 — Verdict

**PASS WITH WARNINGS**

The implementation is correct and complete. All 26 tasks are done. Core behavior (auth on all 6 routes, zod validation, `?? null` fix, `include: { project: true }`, type relaxation) is implemented correctly and type-safe. 342/342 tests pass. `tsc --noEmit` is clean. No DIP violations introduced. No broken behavior.

The 6 warnings are test coverage gaps (not implementation gaps). The code is safe to archive. The warnings should be filed as follow-up items.

**Follow-up backlog**:
1. Add GET /:id route tests (REQ-GET-1, REQ-GET-2)
2. Add `completedAt` assertions to status change tests (REQ-STATUS-4, REQ-STATUS-5)
3. Add `projectName` assertions to list/create/update tests (REQ-LIST-3, REQ-SHAPE-1)
4. Remove or use `RejectingJwtAuthAdapter` in scheduling test file
5. Migrate route `authProvider` param type from `JwtAuthAdapter` to `AuthProvider` port (all modules, not just scheduling)
