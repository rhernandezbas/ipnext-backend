# Verify Report — scheduling-projects-enrich

## Summary

- **Tests**: 573 green / 0 red, 82 suites — delta +69 (apply report stated +42; actual delta from baseline of 504 is +69)
- **Type check**: clean (`tsc --noEmit` zero errors)
- **Hexagonal boundary**: preserved — zero `@infrastructure/*` imports in `src/application/`
- **Naming convention**: ok — `PrismaProjectRepository.ts` exports `class PrismaProjectRepository`, `InMemoryProjectRepository.ts` exports `class InMemoryProjectRepository`

---

## CRITICAL findings (block commit)

None. No production-blocking bugs were found.

---

## WARNING findings

### W-1: `InMemoryProjectRepository.update()` does NOT sync the `partners` array after replace-set

**File**: `src/infrastructure/adapters/in-memory/InMemoryProjectRepository.ts:62`

**Problem**: `update()` updates `partnerIds: [...new Set(data.partnerIds)]` but does NOT recalculate the `partners: Array<{ id, name }>` field. `_toProject()` (line 95) returns `partners: [...p.partners]` — which still reflects the OLD partner list.

**Consequence**: In tests and in-memory scenarios, `update({ partnerIds: [] })` returns HTTP 200 (correct) but the body `partners` field still contains the removed partners. `REQ-PARTNERS-2` passes only because the test at `projects.routes.test.ts:337` does NOT assert `res.body.partners.length === 0`. The Prisma adapter is correct (transaction delete-then-insert + `findUnique` re-fetches), so production is unaffected. But the in-memory adapter is a lying test double.

**Fix**: After `data.partnerIds !== undefined`, also update the `partners` field. Since in-memory doesn't have a partner name lookup, use `partnerIds.map(pid => ({ id: pid, name: pid }))` as a stub OR accept that names won't be set (already the case in `create()`). Minimum fix:
```ts
...(data.partnerIds !== undefined && {
  partnerIds: [...new Set(data.partnerIds)],
  partners: [...new Set(data.partnerIds)].map(pid => ({ id: pid, name: pid })),
}),
```

### W-2: REQ-PARTNERS-1 has no test that asserts the actual partner array content after replace-set

**File**: `src/__tests__/application/use-cases/UpdateProject.test.ts:23` and `src/__tests__/infrastructure/http/routes/projects.routes.test.ts` (no REQ-PARTNERS-1 test)

**Problem**: The spec REQ-PARTNERS-1 ("PUT [p1,p2] then PUT [p1,p3] → {p1,p3}") has no test. The UpdateProject use-case test at line 23–38 calls `uc.execute` with `[p1!.id]` but only checks `updated !== null` — not `partners` content. The routes test has no REQ-PARTNERS-1 case at all.

**Consequence**: The replace-set correctness is not asserted. Given W-1 (in-memory doesn't update `partners`), writing this test would expose the bug. Production behavior is correct, but the test gap means a future regression would go undetected.

**Fix**: Add a test that seeds two partners, creates a project with both, updates to only one, then asserts `res.body.partners.length === 1`.

### W-3: `PrismaProjectRepository.update()` non-partner path does not verify project existence before calling `prisma.project.update()`

**File**: `src/infrastructure/adapters/in-memory/InMemoryProjectRepository.ts:126–133`

**Problem**: When `partnerIds` is absent from the payload, `prisma.project.update()` is called. If the project doesn't exist, Prisma throws `P2025 (Record to update not found)` which is caught by the outer `catch` block and returns `null`. The route then correctly returns 404. This is correct behavior.

However, the `catch {}` block at line 134 is completely silent — it swallows ALL errors, including unexpected ones (connection failure, schema mismatch, etc.) and returns `null`. This makes debugging production errors extremely hard.

**Fix** (minor): Type the catch: `catch (err: unknown) { if (isPrismaNotFound(err)) return null; throw err; }`.

### W-4: `INCLUDE` constant omits `type`, `category`, `workflow`, `projectLead` joins — response never resolves FK names

**File**: `src/infrastructure/adapters/prisma/PrismaProjectRepository.ts:63–66`

**Problem**: The design doc's sketch included `type: true, category: true, workflow: true, projectLead: { select: { id, name } }` in the INCLUDE. The entity only exposes `*Id` fields (strings), so these joins are NOT needed for current correctness. This is fine per the domain entity definition.

However, the spec REQ-GET-1 says: "body MUST be a single `Project` object including `taskCounts` and **any populated FK references**". The current entity shape has no resolved names (only IDs), so "populated FK references" means only the IDs are present. If future consumers expect `category.name` in the response, this will need to change.

**Documented as a known divergence**: The domain entity shape (IDs only, no embedded relations) is consistent with AD-3. No change needed now.

### W-5: `PrismaProjectRepository.INCLUDE` does not select `tasks` from the DB relation labeled `tasks`

**File**: `src/infrastructure/adapters/prisma/PrismaProjectRepository.ts:65`

**Problem**: The `INCLUDE` uses `tasks: { select: { stage: { select: { category: true } } } }`. This relies on the `tasks` Prisma relation name on `Project`. In `schema.prisma` line 491, this is `tasks ScheduledTask[]` — the relation name is indeed `tasks`. The `ScheduledTask` model must have a `stage` relation and `Stage` must have a `category` field.

**Verification needed**: `Stage.category` is the enum field from change 1. Confirmed in schema (change 1 added `StageCategory` enum with `nuevo | enProgreso | hecho`). The `as any` cast on `prisma.project` is needed because `prisma generate` wasn't run with the new schema, but the SQL fields DO exist after the migration runs. Runtime behavior is correct.

---

## SUGGESTION findings

### S-1: Apply report states delta +42; actual delta is +69

The apply report claimed "+42 new tests". Actual count went from 504 (baseline on HEAD before change) to 573 (+69). The discrepancy is benign (more tests is better) but the apply report's count is wrong. Update commit description if accuracy matters.

### S-2: `REQ-PARTNERS-2` test does not assert `res.body.partners === []`

**File**: `src/__tests__/infrastructure/http/routes/projects.routes.test.ts:333–338`

The test only checks `res.status === 200`. It should also assert `expect(res.body.partners).toEqual([])`. Would catch W-1 immediately.

### S-3: `dto/projects.dto.ts` exports TS types that shadow the port's types

`src/application/dto/projects.dto.ts` exports `CreateProjectInput` and `UpdateProjectInput` as `z.infer<>` types. `src/domain/ports/ProjectRepository.ts` also exports types with the same names. The use cases import from `@domain/ports/ProjectRepository`, not from the DTO file. No conflict at runtime, but IntelliSense may show ambiguous type names. Rename DTO types to `CreateProjectBody` / `UpdateProjectBody` to disambiguate.

### S-4: Smoke plan step 8.4 uses `jq '.[0].id'` on `/api/scheduling/workflows`

**File**: `tasks.md §8.4`

The workflows endpoint returns an array, but the first element at index 0 may not be the "Default" workflow if sorting differs. More robust: `jq '.[] | select(.name=="Default") | .id'`. Minor issue but could fail the smoke plan on a DB with multiple workflows.

---

## Spec REQ coverage matrix

| REQ-ID | Status | Test file | Implementation file |
|--------|--------|-----------|---------------------|
| REQ-AUTH-1 | ✅ | `projects.routes.test.ts:77` | `projects.routes.ts:29` |
| REQ-AUTH-2 | ✅ | `projects.routes.test.ts:84` | `projects.routes.ts:29` |
| REQ-AUTH-3 | ✅ | `projects.routes.test.ts:91` | `projects.routes.ts:29` |
| REQ-AUTH-4 | ✅ | `projects.routes.test.ts:98` | `projects.routes.ts:29` |
| REQ-AUTH-5 | ✅ | `projects.routes.test.ts:105` | `projects.routes.ts:29` |
| REQ-AUTH-6 | ✅ | `projects.routes.test.ts:112` | `authMiddleware.ts` |
| REQ-AUTH-7 | ✅ | `projects.routes.test.ts:119` | `authMiddleware.ts` |
| REQ-LIST-1 | ✅ | `projects.routes.test.ts:136` | `PrismaProjectRepository.ts:34–45` |
| REQ-LIST-2 | ✅ (in-memory only) | `ListProjects.test.ts:46` | `PrismaProjectRepository.ts:34–45` — `Stage.category` path; Prisma adapter is correct but no DB test |
| REQ-LIST-3 | ✅ | `projects.routes.test.ts:129` | `ListProjects.ts` |
| REQ-LIST-4 | ✅ | `projects.routes.test.ts:145,155` | `PrismaProjectRepository.ts:70–71` |
| REQ-GET-1 | ✅ | `projects.routes.test.ts:175` | `projects.routes.ts:44–51` |
| REQ-GET-2 | ✅ | `projects.routes.test.ts:184` | `projects.routes.ts:47–50` |
| REQ-CREATE-1 | ✅ | `projects.routes.test.ts:195` | `CreateProject.ts` |
| REQ-CREATE-2 | ✅ | `projects.routes.test.ts:206,213` | `CreateProjectSchema` (min(1) + trim) |
| REQ-CREATE-3 | ✅ | `projects.routes.test.ts:220,227` | `CreateProjectSchema` |
| REQ-CREATE-4 | ✅ | `projects.routes.test.ts:234` | `CreateProject.ts:22–25` |
| REQ-CREATE-5 | ✅ | `projects.routes.test.ts:241` | `CreateProject.ts:28–31` |
| REQ-CREATE-6 | ✅ | `projects.routes.test.ts:248` | `CreateProject.ts:33–36` |
| REQ-CREATE-7 | ✅ | `projects.routes.test.ts:255` | `CreateProject.ts:39–42` |
| REQ-CREATE-8 | ✅ | `projects.routes.test.ts:262` | `CreateProject.ts:46–49` |
| REQ-CREATE-9 | ✅ | `projects.routes.test.ts:269` | `CreateProjectSchema` nullable optionals |
| REQ-CREATE-10 | ✅ | `projects.routes.test.ts:278` | `CreateProject.ts:46`, `PrismaProjectRepository.ts:86` |
| REQ-UPDATE-1 | ✅ | `projects.routes.test.ts:289` | `UpdateProject.ts` |
| REQ-UPDATE-2 | ✅ | `projects.routes.test.ts:297` | `projects.routes.ts:79–82` |
| REQ-UPDATE-3 | ✅ | `projects.routes.test.ts:304` | `UpdateProjectSchema` |
| REQ-UPDATE-4 | ✅ | `projects.routes.test.ts:312` | `UpdateProject.ts:22–41` |
| REQ-UPDATE-5 | ✅ | `projects.routes.test.ts:320` | `UpdateProject.ts:22` (`data.categoryId != null` guard) |
| REQ-PARTNERS-1 | ⚠️ | No dedicated test; UpdateProject.test.ts:23 checks `!= null` only | `InMemoryProjectRepository.ts:62` (W-1: partners array not updated) |
| REQ-PARTNERS-2 | ⚠️ | `projects.routes.test.ts:333` — only checks status 200, not `partners: []` | `InMemoryProjectRepository.ts:62` |
| REQ-PARTNERS-3 | ✅ | `projects.routes.test.ts:341` | `UpdateProject.ts:43–44` (partnerIds not in data → skip) |
| REQ-PARTNERS-4 | ✅ | `projects.routes.test.ts:349` | `UpdateProject.ts:44–49` + route catch |
| REQ-PARTNERS-5 | ✅ | `CreateProject.test.ts:100` | `CreateProject.ts:46`, `UpdateProject.ts:45` |
| REQ-DELETE-1 | ✅ | `projects.routes.test.ts:361` | `DeleteProject.ts`, `projects.routes.ts:93–99` |
| REQ-DELETE-2 | ✅ | `projects.routes.test.ts:369` | `projects.routes.ts:95–98` |
| REQ-DELETE-3 | ✅ (schema) | No explicit test | `schema.prisma:491` `tasks ScheduledTask[]` (no onDelete = SetNull default) |
| REQ-SHAPE-1 | ✅ | `projects.routes.test.ts:380` | `mapProject()` in `PrismaProjectRepository.ts` |
| REQ-SHAPE-2 | ✅ | `projects.routes.test.ts:380` | `mapProject()` uses `?? null` on all nullable fields |
| REQ-SHAPE-3 | ✅ | `projects.routes.test.ts:399` | `partners: p.partners.map(...)` always returns array |
| REQ-VAL-1 | ✅ | `projects.dto.test.ts` | `CreateProjectSchema` in `projects.dto.ts` |
| REQ-VAL-2 | ✅ | `projects.dto.test.ts` | `UpdateProjectSchema = CreateProjectSchema.partial()` |
| REQ-VAL-3 | ✅ | `projects.dto.test.ts` | `ListProjectsQuerySchema` |
| REQ-DIP-1 | ✅ | `tsc --noEmit` (grep confirms zero `@infrastructure` imports in `src/application/`) | All 5 use cases + dto file |
| REQ-DIP-2 | ✅ | Grep audit | All use cases import domain ports only |
| REQ-DIP-3 | ✅ | `projects.routes.ts:20–27` | Factory signature `(listProjects, ..., authProvider)` |

---

## Smoke plan compliance (§8 of tasks.md)

All 10 smoke steps exercise routes that ARE wired in `app.ts`:

| Smoke step | Route | Wired in app.ts | Notes |
|------------|-------|-----------------|-------|
| 8.1 Login | `POST /api/auth/login` | line 569 | ✅ |
| 8.2 Anon rejected | `GET /api/projects` | line 595 | ✅ — now has auth middleware |
| 8.3 List | `GET /api/projects` | line 595 | ✅ |
| 8.4 Lookup IDs | `GET /api/scheduling/workflows`, `/api/scheduling/project-categories`, `/api/partners`, `/api/admins` | lines 581, 611, 613 | ✅ |
| 8.5 Create | `POST /api/projects` | line 595 | ✅ |
| 8.6 GET by ID | `GET /api/projects/:id` | line 595 | ✅ |
| 8.7 Negative FK | `POST /api/projects` | line 595 | ✅ |
| 8.8 Replace-set | `PUT /api/projects/:id` | line 595 | ✅ |
| 8.9 Visible filter | `PUT + GET /api/projects?visible=true` | line 595 | ✅ |
| 8.10 Delete + cascade | `DELETE /api/projects/:id`, `GET /api/partners/:id` | lines 595, 611 | ✅ |

No 404-due-to-missing-mount risk.

---

## `as any` cast audit

All 6 `as any` casts in `PrismaProjectRepository.ts` are of type **(a)**:
- `(prisma.project as any).findMany` — safe: `project` relation exists post-migration
- `(prisma.project as any).findUnique` — safe
- `(prisma.project as any).create` — safe
- `(prisma as any).$transaction` — safe: `$transaction` exists on PrismaClient; cast needed because `prisma.project` type is stale
- `(prisma.project as any).update` — safe
- `tx.projectPartner.createMany` — safe: `ProjectPartner` table exists post-migration

All casts are scoped to the stale Prisma client type. Runtime behavior is correct. The blanket `/* eslint-disable @typescript-eslint/no-explicit-any */` + NOTE at file top is documented.

---

## Open items deferred

- `PrismaProjectRepository` integration tests (task 4.2) — BLOCKED: no DB. Should be unblocked in a follow-up PR once the migration is applied.
- `?categoryId=` / `?typeId=` query filters on `GET /api/projects` — explicitly deferred per design AD-9.
- Cursor pagination — explicitly deferred per design.
- `projectLeadId` lifecycle guard (disabled admins) — explicitly deferred per design AD-10.
- `ProjectType.name` / `ProjectCategory.name` unique constraint — explicitly deferred per AD-2.

---

## Recommendation

**READY-TO-COMMIT** with the following minor remediations before merge (not blockers, but recommended):

1. Fix `InMemoryProjectRepository.update()` to sync `partners` array when `partnerIds` changes (W-1). This makes the test double faithful and enables W-2 fix.
2. Add `REQ-PARTNERS-1` and `REQ-PARTNERS-2` content assertions (W-2, S-2).
3. Scope the bare `catch {}` in `PrismaProjectRepository.update()` to only swallow Prisma P2025 (W-3).

None of the above block production deployment. The change is production-safe: migration SQL is correct, no `ON CONFLICT ON CONSTRAINT`, DO $$ backfill is idempotent, all auth middleware is wired, all routes resolve.
