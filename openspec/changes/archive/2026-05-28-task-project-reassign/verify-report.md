# Verify report — task-project-reassign

**Date**: 2026-05-28
**Test status BE**: PASS (151 suites / 1167 passed, 9 skipped, 0 failed)
**Test status FE**: PASS (146 files / 1170 passed, 1 todo)
**Type status BE**: PASS (no output from `npx tsc --noEmit`)
**Type status FE**: PASS (our files only) — pre-existing errors in StatsTab, NotasCreditoPage, ProformasPage, GponPage, InventoryLegacyPage, RadiusSessionsPage, CustomerSidebar, SettingsPage, TariffsPage (not introduced by this change)
**Overall**: GO

---

## CRITICAL

None.

---

## WARNING

- **tasks.md not ticked**: all items remain `- [ ]` — the apply agent implemented everything but never updated the checklist to `- [x]`. This is a process artifact only; all code, tests, and type gates confirm the work is done. Recommend ticking all items before archiving (or letting `sdd-archive` do it).

- **REQ-CREATE-14 / PUT empty-string deviation**: Design AD-4 stated `UpdateTaskSchema.projectId = z.string().min(1).optional()` (which would 400 on `""`), but the actual schema inherits from `CreateTaskBaseSchema.partial()` making it `z.string().nullable().optional()` — `""` passes Zod. The PUT handler does NOT apply the `""→null` coercion (only POST does). Therefore `PUT` with `projectId: ""` returns 404 `PROJECT_NOT_FOUND` instead of the spec's intended "200 with `projectId: null`". The test at line 1121 of `scheduling.routes.test.ts` documents and asserts this behavior explicitly. This is an **intentional deviation** captured in apply-progress — the FE select never submits `""` (it is required), so no real-world regression exists. However, the spec (REQ-CREATE-14) states PUT MUST return 200 with `projectId: null` for `""`, which the current implementation does not satisfy. A follow-up fix would be: add `projectId: data.projectId === '' ? null : data.projectId` coercion inside the PUT handler before calling `updateTask.execute()`.

---

## SUGGESTION

- `prismaClientLookup` is still misnamed (covers Client, Service, Partner, Project). The one-line comment added above it (`// Covers four entity kinds...`) mitigates this. Rename as a standalone refactor whenever the function is next touched.
- `UpdateTaskSchema.projectId` diverges from the design doc (which assumed `z.string().min(1).optional()`). Consider adding a schema-level test to lock in what the schema actually accepts, so future changes to the base schema don't silently change the update contract.
- The `SchedulingTaskDetailPage.test.tsx` integration test for the project select was added as `it.todo(...)` rather than a full test. This is explicitly acceptable per the tasks spec (see task 6.3), but upgrading it to a real test would give end-to-end coverage of the wiring path.

---

## REQ → test/code coverage matrix

| REQ | Spec | Test(s) | Code |
|-----|------|---------|------|
| REQ-CREATE-12 | scheduling/spec.md §4 | `CreateTask.test.ts:157` — "REQ-CREATE-12: throws ReferenceNotFoundError(project)…"; `scheduling.routes.test.ts:1089` — "POST con projectId inválido → 404 PROJECT_NOT_FOUND" | `CreateTask.ts:31–34` (validation block); `REFERENCE_TO_CODE['project']` in `scheduling.routes.ts:49` |
| REQ-CREATE-13 | scheduling/spec.md §4 | `CreateTask.test.ts:165` — "REQ-CREATE-13a: null projectId skips…"; `CreateTask.test.ts:172` — "REQ-CREATE-13b: absent projectId skips…" | `CreateTask.ts:30` (`if (data.projectId != null)` guard) |
| REQ-CREATE-14 | scheduling/spec.md §4 | `scheduling.routes.test.ts:1111` — "REQ-CREATE-14: POST con projectId vacío → 201 null" ✅; `scheduling.routes.test.ts:1121` — PUT with `""` → 404 (deviation, see WARNING) | `scheduling.routes.ts:309` — POST coercion `(data.projectId === '' ? null : data.projectId) ?? null`; PUT handler: no coercion (deviation) |
| REQ-UPDATE-5 | scheduling/spec.md §5 | `UpdateTask.test.ts:113` — "REQ-UPDATE-5: throws ReferenceNotFoundError(project)…"; `scheduling.routes.test.ts:1099` — "PUT con projectId inválido → 404 PROJECT_NOT_FOUND" | `UpdateTask.ts:31–34` (validation block) |
| REQ-UPDATE-6 | scheduling/spec.md §5 | `UpdateTask.test.ts:121` — "REQ-UPDATE-6: null projectId clears assignment without any lookup" | `UpdateTask.ts:31` (`data.projectId !== undefined && data.projectId !== null` guard) |
| REQ-UPDATE-7 | scheduling/spec.md §5 | `UpdateTask.test.ts:129` — "REQ-UPDATE-7: projectLookup NOT called when projectId absent"; `UpdateTask.test.ts:138` — "repo.updateTask NOT called when lookup fails" | `UpdateTask.ts:31–34` (guard before repo call) |
| REQ-REF-1 | scheduling/spec.md §Ref | Covered structurally: `ReferenceKind` union is `Record<ReferenceKind, string>` — TypeScript compile gate enforces exhaustiveness. No dedicated runtime test; the POST/PUT 404 tests implicitly verify the full chain. | `domain/errors/scheduling.ts:3` — `ReferenceKind` includes `'project'`; `scheduling.routes.ts:49` — `REFERENCE_TO_CODE['project'] = 'PROJECT_NOT_FOUND'` |

---

## Design AD adherence

- **AD-1** ✅ `ReferenceNotFoundError` reused as-is; `'project'` added to `ReferenceKind` union in `scheduling.ts:3`. No dedicated `ProjectReferenceNotFoundError` introduced.
- **AD-2** ✅ `EntityLookup` reused; inline closure wrapper in `app.ts` extended to cover `'Project'` case. No `ProjectLookup` port created.
- **AD-3** ✅ Lookup wired as closure inside `prismaClientLookup` in `app.ts:364–370`, passed inline to constructors at lines 465–480. No separate adapter file.
- **AD-4** ⚠️ Partial. Constructor signature changed without compat shim (correct per AD). However the design assumed `UpdateTaskSchema.projectId = z.string().min(1).optional()` — the actual schema is `z.string().nullable().optional()` (inherited via `.partial()` from the base). The PUT empty-string coercion was NOT added to the route handler. The deviation is documented, tested, and intentional (see WARNING on REQ-CREATE-14).
- **AD-5** ✅ Empty-string coercion in POST handler at route boundary (`scheduling.routes.ts:309`). PUT deviation noted above (AD-4).
- **AD-6** ✅ Existing `StubLookup` pattern reused in all test files — no new shared test infrastructure created.
- **AD-7** ✅ `DatosFormValues.projectId` kept as `string | null`. No discriminated union introduced.
- **AD-8** ✅ IClass warning rendered inline below project select (`DatosForm.tsx`), not as modal or toast.
- **AD-9** ✅ `projectId` piped through existing unified save handler (`handleFormSubmit` in `SchedulingTaskDetailPage.tsx:177`). No dedicated mutation added.
- **AD-10** ✅ Both use-case tests AND route integration tests cover the new validation. Use-case tests prove logic; route tests prove wiring (404 status + body shape).

---

## Discoveries

- **Pre-existing bug fixed in commit 1faa385**: `handleFormSubmit` in `SchedulingTaskDetailPage.tsx` was NOT including `projectId` in the `updateTask` mutation payload — the field was silently dropped on every form save. Confirmed at `SchedulingTaskDetailPage.tsx:178`: `projectId: nullable(values.projectId)` was added by this commit. Without this fix, the project select would have appeared to work in the UI but the value would never have reached the API. This was a latent bug surfaced by adding the project field; it was not introduced by this change.

- **`UpdateTaskSchema.projectId` is `z.string().nullable().optional()`, NOT `z.string().min(1).optional()`**: The design doc assumed `.min(1).optional()` but the schema inherits from `CreateTaskBaseSchema.partial()` which makes it `z.string().nullable().optional()`. This means the PUT endpoint accepts `""` as a valid string and passes it to the use case, which triggers the FK lookup with `id = ""` → 404 `PROJECT_NOT_FOUND`. This is benign in practice (FE never submits `""`) but is a semantic divergence from the spec's intent for REQ-CREATE-14 PUT scenario.

- **FASE 4+5 merged into one commit**: Tasks spec called for two separate FE commits (FASE 4: project select, FASE 5: IClass warning). The apply agent merged them into `1dc17f5` since both touch the same files. The result is cleaner atomically; no functional issue.

- **`DatosForm.test.tsx` was created from scratch**: The test file at `src/__tests__/scheduling/components/DatosForm.test.tsx` did not exist before this change. The apply agent created it with full coverage (15 tests).

---

## Deploy notes

- BE and FE deploys can run independently (per design risk analysis and AD confirmed above).
- Recommended order: **BE first, then FE**. BE-first adds defensive 404 validation; the current FE doesn't submit `projectId` from `DatosForm` yet (field didn't exist before), so zero regression risk.
- FE-first is also safe: the new select sends a valid `projectId` that the current BE accepts without validation (no 500, just silent acceptance of any UUID — pre-existing behavior).
- Pending operator actions: none. No schema migration, no data backfill, no feature flags.
- Known follow-up: `UpdateTaskSchema.projectId` empty-string PUT scenario returns 404 instead of the spec's 200+null. Low priority — FE never produces this. Track as a follow-up to widen the schema or add PUT-level coercion.
