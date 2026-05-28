# Design: Reassign Project on Existing Task

This document answers HOW. Requirements (WHAT) live in the spec. Numbered architecture decisions (AD-N) are intentional and stable — referenced from tasks and verify reports.

## 1. BE — Domain changes

### Change
Extend the `ReferenceKind` union in `src/domain/errors/scheduling.ts`:

```ts
export type ReferenceKind =
  | 'customer' | 'service' | 'partner'
  | 'reporter' | 'assignee' | 'watcher'
  | 'project';
```

Single-line change. The existing `ReferenceNotFoundError` class is generic over `kind` and needs no modification — it already serializes `${kind} not found: ${id}` and the route layer maps `kind → code` via `REFERENCE_TO_CODE`.

### AD-1: Reuse `ReferenceNotFoundError` instead of a dedicated `ProjectReferenceNotFoundError`

The `ReferenceKind` union is the existing mechanism for polymorphic FK rejection in scheduling. Six other reference kinds already share it (customer, service, partner, reporter, assignee, watcher). Introducing a distinct `ProjectReferenceNotFoundError` would fork the pattern for no benefit — error handling at the route boundary is uniform (single `instanceof ReferenceNotFoundError` branch), and the code-mapping table (`REFERENCE_TO_CODE`) is the right place to encode the kind → HTTP code translation.

**Rejected alternative**: dedicated error class. Cost: an extra `catch` branch in the route, divergence from the existing pattern. Benefit: none — the discriminator (`kind`) already gives us all the type-level safety we need.

## 2. BE — Lookup port

### Reuse `EntityLookup`

Verified contract (`src/domain/ports/EntityLookup.ts`):

```ts
export interface EntityLookup {
  findById(id: string): Promise<{ id: string } | null>;
}
```

The existing `PrismaProjectRepository` exposes `get(id): Promise<Project | null>`, **NOT** `findById`. We have two clean options that respect DIP:

**Option A (chosen)**: at the DI boundary, build an inline `EntityLookup` wrapper exactly the same way `Client`/`Service`/`Partner` are wired today (see `prismaClientLookup` in `src/infrastructure/http/app.ts:362`). Extend that helper to a fourth case:

```ts
function prismaClientLookup(
  model: 'Client' | 'Service' | 'Partner' | 'Project',
  id: string,
): Promise<{ id: string } | null> {
  switch (model) {
    case 'Client':  return prisma.client.findUnique({ where: { id }, select: { id: true } });
    case 'Service': return prisma.service.findUnique({ where: { id }, select: { id: true } });
    case 'Partner': return prisma.partner.findUnique({ where: { id }, select: { id: true } });
    case 'Project': return prisma.project.findUnique({ where: { id }, select: { id: true } });
  }
}
```

**Option B (rejected)**: add `findById(id): Promise<{ id: string } | null>` to `ProjectRepository`. Cost: extends a port that today has zero callers needing the cheap lookup — pollutes the repository contract with a method only the EntityLookup pattern needs. Benefit: marginal — Option A already keeps the lookup logic colocated.

### AD-2: Reuse `EntityLookup` and the existing `prismaClientLookup` wrapper

Consistency with the customer/service/partner pattern dominates here. Introducing a `ProjectLookup` port would be the third synonym for the same shape and fragments the codebase. The wrapper function already has the exact ergonomics we want: a single small function in `app.ts` that closes over the Prisma client.

**Note on misleading name**: `prismaClientLookup` is misnamed (it covers Service and Partner too — "Client" there refers to the Customer entity). Renaming is OUT OF SCOPE for this change; we extend it as-is to avoid a noisy diff.

## 3. BE — Use case changes

### `UpdateTask`

Constructor adds a 6th positional arg `projectLookup: EntityLookup`. The new validation block goes between the `partner` block and the `reporter` block, per the proposal's canonical order:

```
customer → service → partner → project → reporter → assignee → watchers
```

```ts
if (data.projectId !== undefined && data.projectId !== null) {
  const found = await this.projectLookup.findById(data.projectId);
  if (!found) throw new ReferenceNotFoundError('project', data.projectId);
}
```

Mirrors `partnerId` exactly. No other behavior change.

### `CreateTask`

Same constructor extension (6th positional arg). Validation block in the same canonical position. `CreateTask` uses `data.X != null` (loose) while `UpdateTask` uses `data.X !== undefined && data.X !== null` (strict). Both expressions are equivalent for our purposes, and we keep the **per-file** style — do not normalize, do not refactor in this change.

### AD-3: Positional constructor args, not an options bag

Every other use case in scheduling uses positional args. Switching `CreateTask`/`UpdateTask` to an options bag would touch >15 call sites in tests and `app.ts` for no functional reason. The added arg is at position 6 — readability is acceptable.

## 4. BE — Empty-string handling at the DTO boundary

Verified contracts:

- `CreateTaskSchema.projectId`: `z.string().nullable().optional()` — `null` allowed, empty string allowed (zod `string()` accepts `""`).
- `UpdateTaskSchema.projectId`: `z.string().min(1).optional()` — `min(1)` REJECTS empty string AND lacks `.nullable()` so the FE cannot send `null` to clear it.

This is a real contract bug for our case: the FE select must be able to either submit a valid UUID or, in the legacy nullable scenario, leave the field alone. **It must NEVER need to send `null` from the project field** (the UI is required), so the current schema is acceptable for this change. We do, however, want defense at the BE layer.

### Decisions

1. **`UpdateTaskSchema`**: leave as-is for project. The FE never submits empty/`null` for `projectId` (the field is required). The `min(1)` constraint provides a 400 if a malformed client tries to send `""`.
2. **`CreateTaskSchema`**: leave as-is. The route already normalizes via `data.projectId ?? null` (line 308 of `scheduling.routes.ts`). Empty-string passes that normalization untouched, which would then fail FK validation with `PROJECT_NOT_FOUND`. That is consistent enough — we are NOT extending the route normalization to convert `""` to `null` because the FE select cannot produce `""` for project (required field) and other callers are out of scope.

### AD-4: Validation contract = "string-or-null, never empty-string" at the use case

The use case receives `projectId: string | null | undefined`. The use case validates ONLY when it is a non-null string. Empty-string handling is the schema's job (`UpdateTaskSchema.min(1)` already enforces it). We do NOT add a route-level `data.projectId === '' ? null : data.projectId` shim because:
1. `UpdateTaskSchema` already 400s on `""`.
2. `CreateTaskSchema` allows `""` syntactically, but FE never submits it and BE FK validation rejects it (404 PROJECT_NOT_FOUND), which is acceptable defensive behavior.

If a follow-up change makes `projectId` clearable from FE, the schema must be widened to `.nullable()` — explicitly out of scope here.

## 5. BE — REFERENCE_TO_CODE extension

In `src/infrastructure/http/routes/scheduling.routes.ts:45`, extend the record:

```ts
const REFERENCE_TO_CODE: Record<ReferenceKind, string> = {
  customer: 'CUSTOMER_NOT_FOUND',
  service:  'SERVICE_NOT_FOUND',
  partner:  'PARTNER_NOT_FOUND',
  reporter: 'REPORTER_NOT_FOUND',
  assignee: 'ASSIGNEE_NOT_FOUND',
  watcher:  'WATCHER_NOT_FOUND',
  project:  'PROJECT_NOT_FOUND',
};
```

Since `Record<ReferenceKind, string>` is exhaustive, the TypeScript compiler will fail the build if `project` is missing from the record — a free correctness check from the union extension in §1.

The errorHandler `statusMap` (`src/infrastructure/http/middleware/errorHandler.ts:18`) already contains `PROJECT_NOT_FOUND: 404`. No middleware change needed.

## 6. BE — DI wiring (`app.ts`)

### Step 1 — extend the helper

`prismaClientLookup` (line 362): add the `'Project'` case as shown in §2.

### Step 2 — pass the lookup to both use cases

```ts
const createTask = new CreateTask(
  schedulingRepo,
  { findById: (id) => prismaClientLookup('Client',  id) },
  { findById: (id) => prismaClientLookup('Service', id) },
  { findById: (id) => prismaClientLookup('Partner', id) },
  adminRepoForScheduling,
  { findById: (id) => prismaClientLookup('Project', id) }, // NEW
);

const updateTask = new UpdateTask(
  schedulingRepo,
  { findById: (id) => prismaClientLookup('Client',  id) },
  { findById: (id) => prismaClientLookup('Service', id) },
  { findById: (id) => prismaClientLookup('Partner', id) },
  adminRepoForScheduling,
  { findById: (id) => prismaClientLookup('Project', id) }, // NEW
);
```

### AD-5: Inline-wrapper closures over a shared `PrismaProjectLookup` adapter file

Today there is no `PrismaCustomerLookup`/`PrismaServiceLookup` adapter file — those lookups live inline as closures over `prismaClientLookup`. Creating a one-off `PrismaProjectLookup.ts` would diverge from that pattern. We mirror exactly what is already there.

## 7. BE — Test fixture impact

### Affected test files (audit pending in sdd-tasks, expected ~10–15 files)

Every constructor call to `new CreateTask(...)` or `new UpdateTask(...)` needs the 6th positional arg.

### Shared stub

Add (or reuse) a stub helper. Two options surface from the codebase:

**Option A**: Reuse the existing `StubLookup` pattern in `src/__tests__/infrastructure/checklists.routes.test.ts` if one exists. (Audit during sdd-tasks. Pattern: `class StubLookup implements EntityLookup { constructor(private ids: string[]) {} async findById(id) { return this.ids.includes(id) ? { id } : null; } }`.)

**Option B**: Introduce a tiny `StubProjectLookup` colocated where the existing FK stubs live. Same shape as the others.

### AD-6: Reuse the existing stub pattern; no new infrastructure

If the codebase already has a generic `StubLookup` taking a set of valid IDs, reuse it. Otherwise duplicate the trivial 6-line class — adding a shared test util just to dedupe 6 lines is over-engineering. Tasks phase will pick A or B based on the audit result.

### Fixture seeding strategy

Most existing CreateTask/UpdateTask tests do NOT set `projectId`. For those, the stub returns `null` for any id — the new validation block is skipped because `projectId` is undefined. Zero behavioral change.

For tests that DO set `projectId` (mainly route integration tests against scheduling.routes), seed the stub with the fixture's UUIDs. A dedicated negative test asserts `PROJECT_NOT_FOUND` for an unseeded id.

## 8. FE — `DatosForm` changes (informational, FE repo)

**Path**: `ipnext-frontend/src/pages/scheduling/SchedulingTaskDetailPage/components/DatosForm.tsx`.

### Required additions

1. Accept a new `projects: Project[]` prop (parent — `SchedulingTaskDetailPage.tsx` — fetches via `useProjects()` and passes down for testability). Same pattern as the existing `admins` / `partners` props.
2. Add a controlled `<select>` bound to `formValues.projectId`. Sort the options by `title` ascending. Disable while `useProjects()` is loading; show a spinner or "Cargando…" placeholder.
3. UI-level required validation: refuse `onSubmit` if `projectId` is null/empty. Use whatever error surface the form already uses (toast or inline) — DO NOT introduce a new error mechanism.
4. Initial value comes from `task.projectId`. Legacy tasks with `null` render an empty select that the operator MUST fill before saving (regularization).

### AD-7: Keep `DatosFormValues.projectId` as `string | null`, not a discriminated union

The API contract is `string | null`. "Required" is a UI rule layered on top — it does NOT belong in the form value type. A discriminated union (`{ kind: 'selected', id: string } | { kind: 'empty' }`) would force ceremonial unwrapping everywhere in the save path and gain nothing the existing nullable string doesn't.

## 9. FE — Warning UX

### Condition

```ts
const showIClassWarning =
  task.iclassOrderCode != null && formValues.projectId !== task.projectId;
```

### Render

Inline warning placed immediately under the project select (NOT a modal, NOT a confirmation step). Copy:

> "Esta tarea ya tiene OS en IClass. El cambio no afecta la OS creada."

Style: warning/info variant of whatever banner component the form already uses.

### AD-8: Inline warning, not a modal

A modal would imply consequences (e.g., that the OS will be rewritten). It will NOT — the OS in IClass is independent. The signal is informational only. Inline placement (a) is non-blocking, (b) is co-located with the source of the change, (c) disappears automatically if the user reverts the selection back to `task.projectId`.

## 10. FE — Submit & save handler

No new API call. `projectId` already flows through `DatosFormValues` → the existing unified save in `SchedulingTaskDetailPage.tsx` → `PUT /api/scheduling/:id`.

### AD-9: Piggyback on the unified save handler

Introducing a dedicated "save project" mutation would force the FE to coordinate two writes for what is conceptually one form submit. Save handler reuse keeps optimistic update / error rollback semantics consistent.

## 11. Errors → HTTP mapping

| Domain error | HTTP status | JSON body code |
|--------------|-------------|----------------|
| `ReferenceNotFoundError('project', id)` | 404 | `PROJECT_NOT_FOUND` |

Route layer: existing `catch (err)` already handles `ReferenceNotFoundError` in both POST and PUT. Body shape is `{ error: string, code: string }` — unchanged.

## 12. Risks & mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| 10+ existing CreateTask/UpdateTask test files break on constructor signature change | High | Audit + fix all call sites in the same commit (test-first per Strict TDD). Single sed-friendly mechanical change. |
| Legacy tasks with `projectId === null` force operators to pick a project before saving any unrelated field | Med | Acceptable per proposal (regularization-on-edit). Document in release notes. |
| FE→BE deploy skew | Low | Either order safe: BE-first adds defensive 404 the FE never triggers (FE doesn't submit project yet); FE-first sends a valid projectId the BE silently accepts (no new validation = no regression). |
| `UpdateTaskSchema.projectId = z.string().min(1).optional()` blocks clearing project to `null` via PUT | Low | Not exercised in this change (FE field is required, never sends null). Out of scope: widening schema to `.nullable()`. |
| `prismaClientLookup` misleading name now also handles Project | Cosmetic | Rename out of scope. Leave a one-line comment above the helper noting it covers four entity kinds. |

## 13. Testing strategy

### BE

**Use-case unit tests** (`src/__tests__/application/`):
- `CreateTask.test.ts`: happy path (no projectId), happy path (valid projectId), reject (`PROJECT_NOT_FOUND`).
- `UpdateTask.test.ts`: same three cases. Add a regression test asserting that when `data.projectId === undefined`, the lookup is NOT called (skip behavior).

**Route integration tests** (supertest, `src/__tests__/infrastructure/scheduling.routes.test.ts`):
- `POST /api/scheduling` with invalid projectId → 404 + `{ code: 'PROJECT_NOT_FOUND' }`.
- `PUT /api/scheduling/:id` with invalid projectId → 404 + `{ code: 'PROJECT_NOT_FOUND' }`.
- `PUT /api/scheduling/:id` reassigning to a valid different project → 200, body shows the new projectId.

### FE (Vitest + Testing Library)

- `DatosForm.test.tsx`:
  - Renders the project `<select>` with one option per provided project, sorted by title.
  - Submit refuses with no project selected (legacy task scenario).
  - Submit succeeds with a project selected; the save payload includes `projectId`.
  - Renders the IClass warning when `task.iclassOrderCode != null` AND the selected projectId differs from `task.projectId`.
  - Does NOT render the warning when `task.iclassOrderCode == null`.
  - Does NOT render the warning when the selected projectId equals `task.projectId`.

### AD-10: Test BOTH layers (use case + route) for the new validation

The use case test proves the logic. The route test proves the wiring (404 status, body shape, REFERENCE_TO_CODE mapping). Skipping either leaves a class of bug uncovered (e.g., correct logic but wrong status code mapping). This mirrors the existing pattern for the other five FK kinds.

## Out of Scope (restated from proposal for traceability)

- Bulk reassign endpoint.
- `Project.projectId` schema migration → NOT NULL.
- `CreateTaskModal` redesign.
- `UpdateTaskSchema.projectId` schema widening to `.nullable()`.
- Renaming `prismaClientLookup`.
