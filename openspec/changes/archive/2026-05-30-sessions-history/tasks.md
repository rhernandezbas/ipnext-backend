# Tasks — sessions-history (Backend)

**Status**: ready
**Repo**: `ipnext-backend`
**Strict TDD**: ACTIVE — every implementation task is preceded by a failing-test task. RED → GREEN → REFACTOR.
**Test runner**: `npx jest` · **Quality gate**: `npx tsc --noEmit`
**Layering**: domain ← application ← infrastructure. Port first → use-case (in-memory tested) → Prisma adapter → HTTP (supertest) → wiring. Never run `npm run build`.

---

## Phase 1 — Domain Port Extension

- [ ] 1.1 In `src/domain/ports/SessionRepository.ts`, add method signature `findRevoked(page: number, pageSize: number): Promise<SessionPage>` to the `SessionRepository` interface. `SessionPage` is already defined in the same file — no new type needed. This makes all existing implementors fail to compile until Phase 2 and 3 are done (expected).

## Phase 2 — InMemory Adapter (TDD)

- [ ] 2.1 [RED] Create `src/__tests__/infrastructure/adapters/in-memory/InMemorySessionRepository.findRevoked.test.ts`:
  - seed 2 active sessions (`revokedAt: null`) + 3 revoked with distinct `revokedAt` timestamps
  - `findRevoked(1, 20)` returns only the 3 revoked, `total: 3` (REQ-SREPO-1 / REQ-SH-3-active-excluded)
  - items are ordered `revokedAt DESC` (latest revoked first)
  - `findRevoked(1, 2)` with 3 revoked → 2 items, `total: 3` (pagination)
  - `findRevoked(2, 2)` → 1 item, `total: 3` (second page)
  - `tokenHash` is present in domain `Session` (it's a domain field) but NOT in DTO — confirm the seed helper exposes it (raw domain object), test that the in-memory result DOES include it (domain layer keeps it; DTO strips it later)
  - Confirm all assertions FAIL.
- [ ] 2.2 [GREEN] Implement `findRevoked(page, pageSize)` in `src/infrastructure/adapters/in-memory/InMemorySessionRepository.ts`:
  - filter `s.revokedAt !== null`
  - sort `revokedAt DESC`, tie-break `__seq DESC`
  - slice by `(page-1)*pageSize` to `page*pageSize`
  - return `{ items: rows.map(clean), total, page, pageSize }`
  - Run tests → GREEN.

## Phase 3 — Use Case (TDD)

- [ ] 3.1 [RED] Create `src/__tests__/application/sessions/ListSessionHistory.test.ts`:
  - setup: `InMemorySessionRepository` with mixed active/revoked sessions seeded via `.seed()`
  - happy path: `execute({})` → `page: 1`, `pageSize: 20`, items ordered `revokedAt DESC`, no `tokenHash` in items (REQ-SH-1)
  - empty: no revoked sessions → `{ items: [], total: 0, page: 1, pageSize: 20 }` (REQ-SH-1 scenario "Historial vacío")
  - active sessions excluded: 2 active + 1 revoked → exactly 1 item in result (REQ-SH-1 scenario 3)
  - pagination: 25 revoked, `execute({ page: 2, pageSize: 20 })` → 5 items, `total: 25` (REQ-SH-2)
  - default params: `execute()` → `page: 1, pageSize: 20` (REQ-SH-2 defaults)
  - `tokenHash` absent: assert `'tokenHash' in result.items[0]` is false (REQ-SH-3)
  - Confirm all FAIL.
- [ ] 3.2 [GREEN] Create `src/application/use-cases/sessions/ListSessionHistory.ts`:
  - imports ONLY from `@domain/*` and `@application/*` — NEVER `@infrastructure/*` (invariant I-1)
  - `DEFAULT_PAGE = 1`, `DEFAULT_PAGE_SIZE = 20`, `MAX_PAGE_SIZE = 100`
  - clamp page (min 1), clamp pageSize (min 1, max 100)
  - delegate to `repo.findRevoked(page, pageSize)`
  - map with `toSessionDto` → return `SessionPageDto`
  - Run tests → GREEN.

## Phase 4 — Prisma Adapter

- [ ] 4.1 [GREEN] Add `findRevoked(page, pageSize)` to `src/infrastructure/adapters/prisma/PrismaSessionRepository.ts`:
  - `where = { revokedAt: { not: null } }`
  - `orderBy: { revokedAt: 'desc' }`
  - `skip: (page-1)*pageSize`, `take: pageSize`
  - `Promise.all([findMany, count])` — same pattern as `listActive`
  - `return { items: rows.map(mapRow), total, page, pageSize }`
  - No migration needed. No new types — reuses existing `SessionRow` and `mapRow`.
  - (No dedicated unit test for Prisma adapter — exercised via integration test in Phase 5.)

## Phase 5 — HTTP Route + Integration Tests (TDD)

- [ ] 5.1 [RED] Create `src/__tests__/infrastructure/sessions.history.integration.test.ts` using supertest + `InMemorySessionRepository` + `InMemoryRbac*` wiring (mirror the existing sessions integration test pattern):
  - `GET /api/admin/sessions/history` authenticated admin → 200, envelope `{ data: [...], total, page, pageSize }` (note: `data` not `items`) (REQ-SH-1)
  - `GET /api/admin/sessions/history` no sessions revoked → 200 `{ data: [], total: 0, page: 1, pageSize: 20 }` (REQ-SH-1 empty)
  - `GET /api/admin/sessions/history?page=2&pageSize=5` with 7 revoked → 200, `data.length === 2`, `total: 7` (REQ-SH-2)
  - `GET /api/admin/sessions/history?pageSize=200` → 400 `{ code: 'VALIDATION_ERROR' }` (REQ-SH-2 max)
  - `GET /api/admin/sessions/history` unauthenticated → 401 (REQ-SH-4)
  - no item in `data` has `tokenHash` key (REQ-SH-3)
  - non-regression: `GET /api/admin/sessions` with mixed sessions → only active ones returned (REQ-SH-5)
  - Confirm all FAIL.
- [ ] 5.2 [GREEN] Update `src/infrastructure/http/routes/sessions.routes.ts`:
  - add `import type { ListSessionHistory } from '@application/use-cases/sessions/ListSessionHistory'`
  - add `listHistory: ListSessionHistory` as second param to `createSessionsRouter()`
  - add `GET /history` route at the TOP of the router (before any `/:id` or `/user/:userId` patterns):
    - `requireView` guard
    - parse `page` (default 1), `pageSize` (default 20)
    - if `pageSize > 100` → `res.status(400).json({ code: 'VALIDATION_ERROR', message: 'pageSize máximo es 100' })` and `return`
    - `const result = await listHistory.execute({ page, pageSize })`
    - `res.json({ data: result.items, total: result.total, page: result.page, pageSize: result.pageSize })`
  - Run integration tests → GREEN.

## Phase 6 — App Wiring

- [ ] 6.1 [GREEN] In `src/infrastructure/http/app.ts`:
  - add `import { ListSessionHistory } from '@application/use-cases/sessions/ListSessionHistory'`
  - after existing session use-case instantiation, add: `const listSessionHistory = new ListSessionHistory(sessionRepo)`
  - update `createSessionsRouter(...)` call to pass `listSessionHistory` as the second argument
  - Verify compile: `npx tsc --noEmit` → 0 errors.

## Phase 7 — Quality Gates

- [ ] 7.1 Run full session test suite: `npx jest sessions` → all GREEN (unit + integration, old + new).
- [ ] 7.2 Run `npx tsc --noEmit` → 0 errors.
- [ ] 7.3 Verify invariants manually:
  - `rg "from '@infrastructure" src/application/use-cases/sessions/ListSessionHistory.ts` → 0 matches (I-1).
  - `rg "tokenHash" src/application/dto/session.dto.ts` → 0 matches (I-2).

---

## Task Summary

| Phase | Focus | Type | Count |
|-------|-------|------|-------|
| 1 | Domain port extension | additive | 1 |
| 2 | InMemory adapter | RED+GREEN | 2 |
| 3 | Use case | RED+GREEN | 2 |
| 4 | Prisma adapter | GREEN | 1 |
| 5 | HTTP route + integration tests | RED+GREEN | 2 |
| 6 | App wiring | GREEN | 1 |
| 7 | Quality gates | verify | 3 |
| **Total** | | | **12** |

New test files: 3 (unit InMemory, unit use-case, integration supertest).
New/modified source files: 6 (port, InMemory adapter, use-case, Prisma adapter, route, app.ts).
