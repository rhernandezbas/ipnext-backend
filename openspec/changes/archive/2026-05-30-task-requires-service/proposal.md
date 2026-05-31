# Proposal: task-requires-service (Backend)

## Intent

`serviceId` is today optional in `CreateTaskSchema` and validated only when present in `CreateTask.ts`. Business rule requires that every new task MUST be linked to a service. This change makes `serviceId` a required field at the application layer (DTO + use case) without any DB migration — the column stays `String?` in Prisma (nullable) because existing tasks may predate the rule and `onDelete: SetNull` must be preserved.

## Scope

### In Scope

- `src/application/dto/scheduling.dto.ts` — change `serviceId` from `.nullable().optional()` to `.min(1)` (required, non-null) in `CreateTaskBaseSchema` (line ~62).
- `src/application/use-cases/CreateTask.ts` — remove the `if (data.serviceId != null)` guard; validate `serviceId` unconditionally (always present). Throw `ReferenceNotFoundError('service', ...)` when not found.
- `src/__tests__/application/CreateTask.test.ts` — invert the existing test that accepted `serviceId: null`; add new scenarios covering the required-service rule.

### Out of Scope

- DB schema migration (column stays nullable — app-level constraint only).
- UpdateTask — `serviceId` remains optional for edits (patch semantics).
- Any other FK fields.
- Frontend (sibling repo, tracked separately in `task-requires-service` FE change).

## Capabilities

### Modified Capabilities

- `scheduling`: delta on the `POST /api/scheduling` create path — `serviceId` becomes required.

## Approach

1. **DTO**: change `serviceId: z.string().min(1).nullable().optional()` → `z.string().min(1)` in `CreateTaskBaseSchema`. `UpdateTaskBaseSchema` (the `.partial()` derivative) is unaffected — `serviceId` remains optional for updates.
2. **Use case**: remove the null-guard around the service FK validation. `serviceId` is now always provided; validate it unconditionally against `serviceLookup.findById`.
3. **Tests (TDD)**: red → green → refactor.
   - Invert the existing test that passes `serviceId: null` — it MUST now be a test that expects a `VALIDATION_ERROR` or `ReferenceNotFoundError`.
   - Add: create without `serviceId` → fails validation (400 at route level / throws at DTO parse level).
   - Add: create with `serviceId` pointing to non-existent service → throws `ReferenceNotFoundError`.
   - Add: create with valid `serviceId` → succeeds (existing happy path, keep it).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/application/dto/scheduling.dto.ts` | Modified | `serviceId` required in `CreateTaskBaseSchema` |
| `src/application/use-cases/CreateTask.ts` | Modified | Remove null-guard; validate `serviceId` unconditionally |
| `src/__tests__/application/CreateTask.test.ts` | Modified | Invert null-service test; add required-field and bad-ref scenarios |
| `src/__tests__/infrastructure/scheduling.routes.test.ts` | Modified | Add test: `POST /api/scheduling` without `serviceId` returns 400 |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Breaks existing integration tests that omit `serviceId` | High | All affected tests are in scope — invert or add `serviceId` to fixtures |
| Frontend sends requests without `serviceId` during transition | Medium | FE change ships in coordination; BE returns clear 400 + `VALIDATION_ERROR` |
| `UpdateTask` regresses — partial updates lose `serviceId` optionality | Low | `UpdateTaskSchema` is a `.partial()` of the base — change only touches `CreateTaskBaseSchema`, not the partial |

## Rollback Plan

Single-PR change. No DB migration. Rollback = `git revert`. Before rollback the API accepts tasks without a service; after rollback it accepts them again. No data is lost.

## Success Criteria

- [ ] `POST /api/scheduling` without `serviceId` returns `400 { code: "VALIDATION_ERROR" }`
- [ ] `POST /api/scheduling` with a `serviceId` that does not exist returns `422` or domain error mapped to `400/404` by the route handler
- [ ] `POST /api/scheduling` with a valid `serviceId` returns `201` (existing happy path unchanged)
- [ ] `PUT /api/scheduling/:id` (update) without `serviceId` still returns `200` (not broken)
- [ ] `npm test` green; `tsc --noEmit` clean
- [ ] No `@infrastructure/*` import introduced in `application/` layer
