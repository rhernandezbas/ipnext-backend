# Proposal: Scheduling Module Hardening

## Intent

The `/api/scheduling` module ships to production with five concrete defects discovered by orchestrator audit: (1) **no auth middleware** — every other module enforces it, scheduling is publicly accessible; (2) **type lies in `PrismaSchedulingRepository.toTask`** — entity declares fields non-null but adapter returns null/undefined, will crash frontend on real DB nulls; (3) **`updateTaskStatus` missing `include: { project: true }`** — returns stale `projectName: null`; (4) **no body validation** — blind cast `req.body as Omit<ScheduledTask,'id'>` produces 500s with Prisma stack traces; (5) **no status enum validation** in PATCH `/:id/status`. Frontend is already wired against these routes and will start consuming them — fix before integration.

## Scope

### In Scope
- Auth middleware on all 6 scheduling routes (mirror `clients.routes.ts:94` pattern)
- Relax 5 entity fields (`description`, `assignedTo`, `assignedToId`, `address`, `notes`) to `string | null`
- Fix `PrismaSchedulingRepository.toTask` (consistent `?? null`, drop `?? undefined`)
- Add `include: { project: true }` to `updateTaskStatus`
- Introduce **zod** body/params validation (new dep, just installed `^4.4.3`) — DTO schemas in `application/dto/scheduling.dto.ts`
- Update `scheduling.routes.test.ts` with auth fake + cover new 400 cases
- Update DI wiring in `app.ts:515` to pass `authAdapter`

### Out of Scope
- Auth gaps in OTHER modules (separate audit)
- Migrating other modules to zod (precedent only)
- Refactoring `app.ts` god object
- Touching frontend (sibling repo) — coordination notes only
- Renaming Prisma adapter naming debt
- Pagination / filtering on `GET /scheduling`

## Capabilities

### New Capabilities
- `scheduling`: Full HTTP capability for scheduled-task CRUD — authentication, validation, status transitions, project relation. Becomes the source spec for this module.

### Modified Capabilities
- None (no prior `openspec/specs/scheduling/` exists).

## Approach

1. **Auth**: import `createAuthMiddleware` + `JwtAuthAdapter` into `scheduling.routes.ts`; accept `authProvider` param; attach `auth` to every route. Wire `authAdapter` in `app.ts:515`.
2. **Type relaxation**: change entity to `string | null` for 5 fields. Prisma adapter already used `?? null` for most — only `description: ?? undefined` line needs fixing.
3. **`updateTaskStatus` bug**: add `include: { project: true }` to the `.update(...)` call.
4. **Validation**: create `application/dto/scheduling.dto.ts` exporting `CreateTaskSchema`, `UpdateTaskSchema`, `UpdateStatusSchema` (zod). Route handlers call `.safeParse(req.body)`, return `400 { error, code: 'VALIDATION_ERROR', details }` on failure.
5. **Tests (TDD)**: red-green-refactor. New tests: 401 without cookie; 400 invalid body; 400 invalid status; `projectName` present after status change.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/domain/entities/scheduling.ts` | Modified | Relax 5 fields to `string \| null` |
| `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts` | Modified | Fix `toTask`, add `include` to `updateTaskStatus` |
| `src/infrastructure/http/routes/scheduling.routes.ts` | Modified | Add auth + zod validation; signature gains `authProvider` |
| `src/infrastructure/http/app.ts` | Modified (line 515) | Pass `authAdapter` to `createSchedulingRouter` — flagged: touches God Object |
| `src/application/dto/scheduling.dto.ts` | New | Zod schemas for create/update/status |
| `src/__tests__/infrastructure/scheduling.routes.test.ts` | Modified | Auth fake + new 400/401 cases |
| `package.json` | Modified | `zod` already added |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Frontend breaks when receiving `null` in fields previously typed `string` | High | Coordination note below; document required frontend changes in proposal |
| `zod` as project precedent — other modules may diverge | Medium | Explicit "Out of Scope" + design phase documents the convention |
| Existing `scheduling.routes.test.ts` breaks (no auth wiring) | High | TDD: update tests in same change, fake `JwtAuthAdapter` returning a user |
| Touches `app.ts` (god object) | Low | One-line change passing already-constructed `authAdapter`; no new wiring complexity |

## Frontend Coordination (NOT part of this change)

Frontend team must:
- Update `ipnext-frontend/src/types/scheduling.ts:7-11` — change `description`, `assignedTo`, `assignedToId`, `address`, `notes` to `string | null`.
- Add null guards in any component that calls `.length`, `.includes`, etc. on those fields (suggest `?? ''`).
- No changes needed to `scheduling.api.ts`, `useScheduling.ts`, or axios config — URLs/payloads unchanged.
- Auth: frontend already sends cookies via `withCredentials: true` — no change required if user is logged in.

## Rollback Plan

Single-PR change. Rollback = `git revert` of the merge commit. No DB migration, no env var, no infra. Frontend impact is type-level only; reverting backend leaves the frontend types slightly conservative (non-null where backend returns null), but no runtime regression because before this change the backend was already returning nulls.

## Dependencies

- `zod ^4.4.3` (already installed)
- Frontend team must apply type relaxation in coordination before merge to avoid runtime errors in production

## Success Criteria

- [ ] All 6 scheduling routes return `401` without valid `auth_token` cookie
- [ ] `POST` / `PUT` with malformed body return `400` with `code: 'VALIDATION_ERROR'`
- [ ] `PATCH /:id/status` with invalid status returns `400`
- [ ] `PATCH /:id/status` response includes correct `projectName` when task has project
- [ ] `npm test` green; `tsc --noEmit` clean
- [ ] No new use-case imports from `@infrastructure/*` (DIP preserved)
- [ ] Frontend types updated in coordination (tracked separately by FE team)
