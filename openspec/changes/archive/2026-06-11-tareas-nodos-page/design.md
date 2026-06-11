# Design: Tareas Nodos Page (Backlog #40)

## Technical Approach

Mirror #39's `allowsEquipmentRetirement` flag pattern byte-for-byte for `Project.isNetworkProject`; add `kind` to the task-list filter (Prisma + InMemory parity); enforce project↔kind symmetry in `CreateTask` via a widened project lookup (no extra query). FE: extract the existing Tareas page into a shared parameterized base; the Nodos page is a thin wrapper with `kind='network'` fixed OUTSIDE the URL.

## Architecture Decisions

| Decision | Options | Choice + Rationale |
|---|---|---|
| PATCH guard | new perm key vs `scheduling.manage` | `requirePerm('scheduling','manage')` injected as **9th param** `requireSchedulingManage?` of `createProjectsRouter` (after `requireInventoryManage`, `app.ts:1275`). Inline middleware `requireManageForNetworkFlag` gates only when `'isNetworkProject' in req.body` — exact mirror of `requireManageForRetirementFlag` (`projects.routes.ts:126-131`). Key exists (workflows RBAC). |
| Backdoor prevention | allow in PUT vs PATCH-only | `isNetworkProject` added to `UpdateProjectSchema` ONLY; `PutProjectSchema` excludes it (zod strips unknown keys → PUT silently ignores). Same as #39 (`projects.dto.ts:18-23`). |
| CreateTask flag source | second lookup port (N+1) vs widen existing | **Widen the existing 6th ctor param** `projectLookup` from `EntityLookup` to new port `ProjectKindLookup` (`domain/ports/ProjectKindLookup.ts`): `findById(id): Promise<{ id: string; isNetworkProject: boolean } | null>`. The single existing `findById` at `CreateTask.ts:51-54` now returns the flag too — existence check + guard from ONE query, no N+1. app.ts wires a new sibling of `prismaClientLookup` (app.ts:539): `prismaProjectKindLookup = (id) => prisma.project.findUnique({ where: { id }, select: { id: true, isNetworkProject: true } })` replacing the wrapper at `app.ts:701`. |
| Guard error | 400 vs 409 vs 422 | `ProjectKindMismatchError extends DomainError`, code `PROJECT_KIND_MISMATCH`, in `domain/errors/scheduling.ts`; mapped to **422** in `scheduling.routes.ts` POST `/` catch (line ~500, beside `ReferenceNotFoundError→404`). Precedent: #39's `PROJECT_NOT_RETIREMENT` → 422. |
| FE page | fork SchedulingTasksPage vs shared base | **Shared base**: extract `SchedulingTasksPage/index.tsx` (145 lines) into `TasksPageBase.tsx` with props `{ title, kind?, modalDefaultMode?, projectPredicate?, columnsStorageKey? }`. Old page = `<TasksPageBase title="Tareas" />` (byte-identical render, existing tests pin it). Justification: bulk-move/column/refetch logic stays single-fix-point; #41 lands in shared children (`TaskFilterBar`, `useTasksFilterUrl`, `buildFilterParams`) either way, so the fork buys nothing and risks drift. |
| `kind` in URL? | URL param vs page constant | Page constant merged at fetch time: `useFilteredTasks({ ...backendFilter, kind })`. `useTasksFilterUrl` UNTOUCHED by #40 → zero overlap with #41's status work there. Users can't un-filter via URL editing. |

## Backend Changes

### Schema + migration
- `prisma/schema.prisma` Project (~1065): `isNetworkProject Boolean @default(false)`.
- `prisma/migrations/20260622000000_project_network_flag/migration.sql` (sorts after `20260621000000_project_retirement_flag`):
```sql
ALTER TABLE "Project"
  ADD COLUMN IF NOT EXISTS "isNetworkProject" BOOLEAN NOT NULL DEFAULT false;
```
**NO `BEGIN`/`COMMIT` inside migration.sql** (gotcha 2026-06-10). Additive, metadata-only in PG.

### DTO / entity / mappers (all mirror `allowsEquipmentRetirement` line-for-line)
- `domain/entities/project.ts:10` → `isNetworkProject: boolean`.
- `domain/ports/ProjectRepository.ts:14-17` → `UpdateProjectInput.isNetworkProject?: boolean`.
- `application/dto/projects.dto.ts:39-46` → `UpdateProjectSchema.extend({ isNetworkProject: z.boolean().optional() })`.
- `PrismaProjectRepository.ts` (rows 28, 59, 105, 191-192 pattern) + `InMemoryProjectRepository.ts` (44, 84, 160) — parity on row type, toProject, create-default, update.

### kind filter
- `application/dto/scheduling.dto.ts:120-131`: `kind: z.enum(['customer','network']).optional()`.
- `scheduling.routes.ts:129-140` rawQuery: `kind: req.query['kind']`.
- `PrismaSchedulingRepository.listTasks` (~184): `if (filter?.kind) where['kind'] = filter.kind;`
- `InMemorySchedulingRepository.listTasks` (~290): `if (filter.kind) tasks = tasks.filter(t => t.kind === filter.kind);`

### CreateTask symmetric guard (`CreateTask.ts:51-54`)
```ts
if (data.projectId != null) {
  const project = await this.projectLookup.findById(data.projectId);   // ProjectKindLookup — single call
  if (!project) throw new ReferenceNotFoundError('project', data.projectId);
  const wantsNetwork = data.kind === 'network';
  if (wantsNetwork !== project.isNetworkProject)
    throw new ProjectKindMismatchError(data.projectId, data.kind ?? 'customer');
}
```
All prod projects start `false` ⇒ customer flow no-op until ops tag; network tasks without `projectId` skip the guard (FE requires project anyway).

## Wire Contract (verbatim — both repos build against this)

1. `GET /api/scheduling?kind=network` — `kind: 'customer' | 'network'`, optional. Omitted ⇒ all kinds (Tareas/Projects pages unchanged). Invalid value ⇒ 400 `VALIDATION_ERROR`.
2. Project DTO (all GET/POST/PUT/PATCH responses): `+ isNetworkProject: boolean` (always present; default `false`).
3. `PATCH /api/projects/:id` body `{ "isNetworkProject": boolean }` → 200 updated Project; **403** (requirePerm standard body) when caller lacks `scheduling.manage` and the key is present. `PUT /api/projects/:id` ignores the field (schema-stripped).
4. `POST /api/scheduling` with `kind`/project mismatch → **422** `{ "error": "...", "code": "PROJECT_KIND_MISMATCH" }`.

## Frontend Changes

| File | Action |
|---|---|
| `src/types/project.ts` | `isNetworkProject?: boolean` |
| `src/types/scheduling.ts` (TaskListFilter) + `src/api/scheduling.api.ts` (buildFilterParams) | add `kind` key (additive; distinct from #41's `status`) |
| `src/pages/scheduling/SchedulingTasksPage/TasksPageBase.tsx` | NEW — extracted base (see decision) |
| `src/pages/scheduling/SchedulingTasksPage/index.tsx` | becomes `<TasksPageBase title="Tareas" projectPredicate={p => !p.isNetworkProject} />` (predicate filters the MODAL list only — `TasksTableView` keeps ALL projects for label resolution since network tasks still appear here) |
| `src/pages/scheduling/SchedulingNodeTasksPage/index.tsx` | NEW — `<TasksPageBase title="Tareas Nodos" kind="network" modalDefaultMode="network" projectPredicate={p => p.isNetworkProject === true} columnsStorageKey="nodeTasks" />` |
| `src/App.tsx` (~245, scheduling block) | lazy import + `<Route path="nodos" element={<RequirePermission permission="scheduling.read"><SchedulingNodeTasksPage /></RequirePermission>} />` |
| `Sidebar.tsx:136` | insert `{ to: '/admin/scheduling/nodos', label: 'Tareas Nodos' }` after Tareas |
| `CreateTaskModal.tsx` | new optional prop `defaultMode?: 'customer' \| 'network'`. Semantics: when present → initial `taskMode = defaultMode` AND toggle hidden (header shows static "Nodo RED" badge), mode locked. Absent → current behavior. Backward-compatible with `TicketDetailPage.tsx:225` / `SchedulingCalendarPage/index.tsx:331`. |
| `CreateTaskModal.tsx` (address prefill) | on `networkSiteId` change in network mode, prefill `address` from `useNetworkSites()` cache (`site.address ?? ''` + city — same query key NodeSelector already fetches; zero new endpoints). Ref-guard `filledForSite` mirrors `filledForCustomer` (lines 122-130) so manual edits never get clobbered. Editable. |
| `SchedulingCalendarPage/index.tsx:331` + `TicketDetailPage.tsx:225` | pass `projects.filter(p => !p.isNetworkProject)` — customer-only call sites must exclude network projects or BE 422s |
| `src/pages/scheduling/settings/NetworkProjectsBody.tsx` | NEW — mirror of `RetirementProjectsBody.tsx` (useProjects('all') + useUpdateProject PATCH `{ isNetworkProject }`), `Can permission="scheduling.manage"` toggle with read-only fallback |
| `SchedulingSettingsPage.tsx:11-18` | add tab `{ id: 'proyectos-red', label: 'Proyectos de red', content: <NetworkProjectsBody /> }` |

## Testing Strategy (strict TDD — red first)

| Piece | Test |
|---|---|
| Migration hygiene | `migration.project_network_flag.test.ts` — mirrors `migration.project_retirement_flag.test.ts`: asserts `IF NOT EXISTS`, `DEFAULT false`, **no BEGIN/COMMIT** |
| Entity/DTO | `project.test.ts` + `UpdateProject.test.ts` (InMemory pass-through) |
| PATCH guard + PUT backdoor | `projects.routes.test.ts`: PATCH w/ flag → 403 when guard denies, 200 when allows; PATCH w/o flag bypasses guard; PUT with flag → field ignored |
| **Composition root (W6)** | NEW `projects-network-flag-composition.test.ts` — STATIC pattern from `inventory-composition-root.test.ts:19-32`: `readFileSync(app.ts)` + regex asserting the `createProjectsRouter(...)` call at app.ts:1275 contains `requirePerm('scheduling', 'manage')` as 9th arg, AND the `new CreateTask(` block wires `prismaProjectKindLookup` (select includes `isNetworkProject: true`) |
| kind filter parity | DTO schema test (rejects bad kind); InMemory listTasks filter test; supertest `GET /api/scheduling?kind=network` returns only network tasks |
| CreateTask guard | `CreateTask` use-case tests with stub `ProjectKindLookup`: network+untagged → `ProjectKindMismatchError`; customer+tagged → error; customer+untagged → ok (no-op proof); network w/o project → ok |
| FE | `TasksPageBase` render parity (existing SchedulingTasksPage tests unchanged); NodeTasksPage passes `kind`/filtered projects; CreateTaskModal `defaultMode` hides toggle + locks mode + address prefill; NetworkProjectsBody mirror of `RetirementProjectsBody.test.tsx`; calendar/ticket call-site filtering |

Gate: `tsc --noEmit` both repos. No casual `app.ts` growth beyond the named 9th arg + lookup helper.

## Migration / Rollout

**Deploy order BE→FE.** BE first is safe: flag defaults `false` everywhere ⇒ guard is a no-op, `kind` filter unused, DTO field ignored by old FE. Post-deploy: ops tag "Red - fibra" + "Red Wireless" via Scheduling → Configuración → Proyectos de red, then verify node modal lists exactly those 2 and client modal excludes them. Rollback: revert code; column stays (additive, inert).

## #41 Seam Plan (status open/closed/dismissed lands on BOTH lists)

Files #41 will also touch — #40 keeps each additive:
- BE `scheduling.dto.ts` (`ListTasksFilterSchema`): #40 adds key `kind`, #41 adds key `status` — disjoint lines.
- BE `scheduling.routes.ts` rawQuery (~129-140): one added line each.
- BE `PrismaSchedulingRepository.listTasks` + `InMemorySchedulingRepository.listTasks`: one `if` each.
- FE `types/scheduling.ts`, `api/scheduling.api.ts` (buildFilterParams): one key each.
- FE `useTasksFilterUrl.ts` + `TaskFilterBar.tsx`: **untouched by #40** (kind is a page constant, not URL state) — #41 gets them conflict-free; status chips added to TaskFilterBar automatically reach both pages via `TasksPageBase`.

## Open Questions

None blocking. (Exact prod titles of the 2 projects are irrelevant by design — ops tag via UI.)
