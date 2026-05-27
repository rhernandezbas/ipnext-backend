# Tasks: Scheduling Module Hardening

## Phase 1 — Foundation (types + DTOs)

1.1 [x] Relax 5 fields in `src/domain/entities/scheduling.ts` to `string | null`: `description`, `assignedTo`, `assignedToId`, `address`, `notes`
1.2 [x] Run `tsc --noEmit` — confirm zero type errors before proceeding
1.3 [x] Create `src/application/dto/scheduling.dto.ts` with `CreateTaskSchema`, `UpdateTaskSchema`, `UpdateStatusSchema` and inferred types (per design §Interfaces)

## Phase 2 — TDD: Auth layer

2.1 [x] [RED] Add 6 failing tests in `scheduling.routes.test.ts`: one per route (GET /, GET /:id, POST /, PUT /:id, DELETE /:id, PATCH /:id/status) asserting 401 + `{ code: "UNAUTHORIZED" }` with no cookie — REQ-AUTH-1..6
2.2 [x] Run `npm test` — confirm all 6 new tests fail
2.3 [x] [GREEN] Introduce fake `JwtAuthAdapter` + mount `cookie-parser` in `buildApp` helper in `scheduling.routes.test.ts`; add `.set('Cookie', 'auth_token=fake')` to all existing happy-path requests so they keep passing
2.4 [x] [GREEN] Update `createSchedulingRouter` signature in `scheduling.routes.ts` to accept `authProvider`; create `auth = createAuthMiddleware(authProvider)`; attach `auth` as second arg on all 6 routes — REQ-DIP-2
2.5 [x] [GREEN] Update `app.ts:515` to pass `authAdapter` to `createSchedulingRouter`
2.6 [x] Run `npm test` — all 6 auth tests green; existing tests still pass

## Phase 3 — TDD: Validation layer

3.1 [x] [RED] Add failing tests in `scheduling.routes.test.ts` for POST with missing `title` → 400 `VALIDATION_ERROR` (REQ-CREATE-2), invalid `estimatedHours` type → 400 (REQ-CREATE-3), invalid `status` enum → 400 (REQ-CREATE-4), invalid `priority` → 400 (REQ-CREATE-5), invalid `category` → 400 (REQ-CREATE-6)
3.2 [x] [RED] Add failing tests for PUT /:id with invalid `estimatedHours` type → 400 (REQ-UPDATE-3), invalid `status` value → 400 (REQ-UPDATE-4)
3.3 [x] [RED] Add failing tests for PATCH /:id/status with `status: "done"` → 400 (REQ-STATUS-2), empty body → 400 (REQ-STATUS-3)
3.4 [x] Run `npm test` — confirm all new validation tests fail
3.5 [x] [GREEN] Wire `CreateTaskSchema.safeParse(req.body)` in POST handler; `UpdateTaskSchema.safeParse` in PUT; `UpdateStatusSchema.safeParse` in PATCH /:id/status — return `400 { error, code: 'VALIDATION_ERROR', details }` on failure
3.6 [x] Run `npm test` — all validation tests green

## Phase 4 — TDD: Adapter bugfixes

4.1 [x] [RED] Add unit test on `PrismaSchedulingRepository.toTask` (or focused integration test) asserting `description` maps to `null` (not `undefined`) when DB row has `null` — REQ-NULL-5, REQ-NULL-9
4.2 [x] [RED] Add integration test in `scheduling.routes.test.ts` asserting PATCH /:id/status response includes non-null `projectName` when task has `projectId` set — REQ-STATUS-7; document limitation: InMemory adapter may not simulate this; use a stub or override `toTask` in the fake repo
4.3 [x] Run `npm test` — confirm both new tests fail
4.4 [x] [GREEN] Fix `PrismaSchedulingRepository.ts:9` — change `description: row.description ?? undefined` to `?? null`
4.5 [x] [GREEN] Add `include: { project: true }` to the `.update(...)` call inside `updateTaskStatus` in `PrismaSchedulingRepository.ts`
4.6 [x] Run `npm test` — all adapter tests green

## Phase 5 — Verification

5.1 [x] Run `npm test` — full suite green
5.2 [x] Run `tsc --noEmit` — zero errors
5.3 [x] Confirm `src/application/dto/scheduling.dto.ts` has no imports from `@infrastructure/*` — REQ-DIP-1
5.4 [x] Confirm `app.ts` change is exactly one line (passing `authAdapter`)

## Phase 6 — Coordination (tracked, not code)

6.1 [x] Log frontend coordination tasks per `proposal.md §Frontend Coordination`: FE must relax 5 fields to `string | null` in `ipnext-frontend/src/types/scheduling.ts:7-11` and add null guards before merge

## Phase 7 — Post-verify fixes

7.1 [x] [W-1] Remove dead `RejectingJwtAuthAdapter` class from `scheduling.routes.test.ts`; simplify `buildApp()` to always use `FakeAuthProvider`; remove unused `authed` param and `AuthenticationError` import
7.2 [x] [W-2] Add 2 HTTP tests for `GET /api/scheduling/:id`: REQ-GET-1 (200 + task body with correct id) and REQ-GET-2 (404 + `code: 'TASK_NOT_FOUND'`); tests added retroactively — route already implemented correctly
7.3 [x] [W-3] Add 2 HTTP tests for `completedAt` behavior via PATCH /:id/status: REQ-STATUS-4 (status=completed auto-sets completedAt as valid ISO string) and REQ-STATUS-5 (changing completed→in_progress preserves original completedAt); tests added retroactively — InMemory already correct
7.4 [x] [W-4] Add 3 assertions for `projectName` field presence in GET list (REQ-LIST-3), POST create (REQ-SHAPE-1a), PUT update (REQ-SHAPE-1b); also added `projectName` to `CreateTaskSchema` DTO and normalization in POST route handler; updated InMemory fixture tasks to include explicit `projectId: null, projectName: null`
7.5 [x] [W-5] Switch `authMiddleware.ts` and `scheduling.routes.ts` to use `AuthProvider` port instead of concrete `JwtAuthAdapter`; update test `FakeJwtAuthAdapter` → `FakeAuthProvider implements AuthProvider` with full interface; all `as any` casts removed; other routes (billing, clients, tickets, auth) continue passing `JwtAuthAdapter` instances — zero breakage (structural subtype)
