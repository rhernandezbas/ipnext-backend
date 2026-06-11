# Tasks: Tareas Nodos Page (#40)

## Wire Contract (verbatim — both repos build against this)

1. `GET /api/scheduling?kind=network` — `kind: 'customer' | 'network'`, optional. Omitted ⇒ all kinds. Invalid value ⇒ 400 `VALIDATION_ERROR`.
2. Project DTO (all responses): `+ isNetworkProject: boolean` (always present; default `false`).
3. `PATCH /api/projects/:id` body `{ "isNetworkProject": boolean }` → 200 / **403** without `scheduling.manage`. `PUT /api/projects/:id` ignores the field (schema-stripped).
4. `POST /api/scheduling` with `kind`/project mismatch → **422** `{ "code": "INVALID_PROJECT_KIND" }`.

---

## Parallelization Plan

- Phases 1–3 are **BE** (sequential dependency chain).
- Phases 4–5 are **FE** (can run in parallel with BE Phases 2–3, after Phase 1 schema is frozen).
- Phase 6 is gates — run after all BE + FE are green.

```
Phase 1 BE (migration + schema)
  ↓
Phase 2 BE (domain/application) ∥ Phase 4 FE (base + page + modal + call sites)
Phase 3 BE (routes + wiring + composition-root test) ∥ Phase 5 FE (settings + sidebar)
  ↓
Phase 6 Gates
```

---

## Phase 1 — BE: Migration + Schema + DTO Foundation

> **Covers**: REQ-PROJ-NET-1, REQ-PROJ-NET-2, REQ-SHAPE-1, REQ-VAL-1, REQ-VAL-2

- [x] 1.1 [RED] Write `src/__tests__/infrastructure/migration.project_network_flag.test.ts` — mirror `migration.project_retirement_flag.test.ts`: assert `endsWith('_project_network_flag')` dir exists, SQL contains `ADD COLUMN IF NOT EXISTS "isNetworkProject" BOOLEAN NOT NULL DEFAULT false`, no BEGIN/COMMIT, no updatedAt DEFAULT. Must fail (no migration yet).
- [x] 1.2 [GREEN] Create `prisma/migrations/20260622000000_project_network_flag/migration.sql` with the `ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "isNetworkProject" BOOLEAN NOT NULL DEFAULT false;` statement only. No BEGIN/COMMIT. Run test — must pass.
- [x] 1.3 [GREEN] Add `isNetworkProject Boolean @default(false)` to `Project` model in `prisma/schema.prisma` (~line 1065, mirror `allowsEquipmentRetirement`).
- [x] 1.4 [GREEN] Add `isNetworkProject: boolean` to `domain/entities/project.ts` (mirror `allowsEquipmentRetirement`).
- [x] 1.5 [GREEN] Add `isNetworkProject?: boolean` to `UpdateProjectInput` in `domain/ports/ProjectRepository.ts` (~lines 14-17).
- [x] 1.6 [GREEN] Update `application/dto/projects.dto.ts`: add `isNetworkProject: z.boolean().optional()` to `UpdateProjectSchema` (~lines 39-46). Add same to `CreateProjectSchema`. `PutProjectSchema` MUST NOT include it (zod strips unknown — confirmed by design).
- [x] 1.7 [GREEN] Update `PrismaProjectRepository.ts`: add `isNetworkProject` to row type, `toProject` mapper, `create` defaults, `update` pass-through (rows 28, 59, 105, 191-192 pattern — mirror `allowsEquipmentRetirement`).
- [x] 1.8 [GREEN] Update `InMemoryProjectRepository.ts`: same parity — row default, `toProject`, create, update (rows 44, 84, 160 pattern).
- [x] 1.9 [RED] Write/extend `src/__tests__/application/projects.test.ts` (or `UpdateProject.test.ts`): InMemory round-trip — create project, PATCH `isNetworkProject: true`, GET returns `true`; create with no flag → defaults `false`. Must fail before 1.8.
- [x] 1.10 Verify Phase 1: `npx jest --runInBand --testPathPattern="migration.project_network_flag|project"` — all green.

---

## Phase 2 — BE: Domain / Application (guard, filter, new port)

> **Covers**: REQ-KIND-FILTER-1, REQ-KIND-FILTER-2, REQ-PROJECT-KIND-GUARD-1, REQ-PROJECT-KIND-GUARD-2, REQ-CREATE-12

- [x] 2.1 [RED] Write `src/__tests__/application/CreateTask.kind-guard.test.ts`: stub `ProjectKindLookup` — network task + `isNetworkProject:false` → throws `ProjectKindMismatchError`; customer task + `isNetworkProject:true` → throws; customer + `isNetworkProject:false` → ok; network w/o projectId → ok; non-existent project → throws `ReferenceNotFoundError` (not kind error). Must fail.
- [x] 2.2 [GREEN] Create `domain/ports/ProjectKindLookup.ts`: `interface ProjectKindLookup { findById(id: string): Promise<{ id: string; isNetworkProject: boolean } | null> }`.
- [x] 2.3 [GREEN] Create `domain/errors/ProjectKindMismatchError.ts` (or add to `domain/errors/scheduling.ts`): `class ProjectKindMismatchError extends DomainError`, code `PROJECT_KIND_MISMATCH`.
- [x] 2.4 [GREEN] Widen 6th constructor param of `CreateTask` from `EntityLookup` to `ProjectKindLookup` in `application/use-cases/CreateTask.ts`. Replace project lookup block (~lines 51-54) with design's guard logic (existence → kind check → persist).
- [x] 2.5 [RED] Write `src/__tests__/application/scheduling-kind-filter.test.ts`: `InMemorySchedulingRepository.listTasks({ kind: 'network' })` returns only network tasks; `{ kind: 'customer' }` returns only customer tasks; omitted returns all. Must fail.
- [x] 2.6 [GREEN] Add `kind?: 'customer' | 'network'` to `application/dto/scheduling.dto.ts` `ListTasksFilterSchema` (~lines 120-131) and to the domain `TaskListFilter` type.
- [x] 2.7 [GREEN] Add `if (filter.kind) tasks = tasks.filter(t => t.kind === filter.kind)` to `InMemorySchedulingRepository.listTasks` (~line 290).
- [x] 2.8 [GREEN] Add `if (filter?.kind) where['kind'] = filter.kind` to `PrismaSchedulingRepository.listTasks` (~line 184).
- [x] 2.9 Verify Phase 2: `npx jest --runInBand --testPathPattern="CreateTask|scheduling-kind-filter"` — all green.

---

## Phase 3 — BE: Routes + PATCH Guard + Composition-Root Test

> **Covers**: REQ-PROJ-NET-2, REQ-PROJ-NET-3, REQ-KIND-FILTER-1, W6 composition guard

- [x] 3.1 [RED] Extend `src/__tests__/infrastructure/http/projects.routes.test.ts`: PATCH with `{ isNetworkProject: true }` + no `scheduling.manage` → 403; same PATCH with `scheduling.manage` → 200 + field updated; PUT with `{ isNetworkProject: true }` → field ignored in response; PATCH without `isNetworkProject` bypasses guard → 200. Must fail.
- [x] 3.2 [GREEN] Add `requireManageForNetworkFlag` inline middleware to `infrastructure/http/routes/projects.routes.ts` (~line 126-131, mirror `requireManageForRetirementFlag`). Add `requireSchedulingManage?` as 9th param to `createProjectsRouter` (after `requireInventoryManage`, `app.ts:1275`).
- [x] 3.3 [RED] Extend scheduling routes test `src/__tests__/infrastructure/http/scheduling.routes.test.ts`: `GET /api/scheduling?kind=network` returns only network tasks; `?kind=mixed` → 400 `VALIDATION_ERROR`; no `kind` → all tasks.
- [x] 3.4 [GREEN] Wire `kind: req.query['kind']` into raw query extraction in `scheduling.routes.ts` (~lines 129-140). Add `INVALID_PROJECT_KIND`→422 mapping in `POST /api/scheduling` catch block (~line 500).
- [x] 3.5 [RED] Write `src/__tests__/infrastructure/projects-network-flag-composition.test.ts` — STATIC: `readFileSync(app.ts)` + regex asserting `createProjectsRouter(...)` call contains `requirePerm('scheduling', 'manage')` as 9th arg AND `new CreateTask(` block contains `prismaProjectKindLookup` (select includes `isNetworkProject: true`). Must fail.
- [x] 3.6 [GREEN] Wire in `app.ts`: define `prismaProjectKindLookup = (id) => prisma.project.findUnique({ where: { id }, select: { id: true, isNetworkProject: true } })` (~line 539); pass it as 6th arg to `new CreateTask(` replacing the old `prismaClientLookup` wrapper (~line 701); pass `requirePerm('scheduling', 'manage')` as 9th arg to `createProjectsRouter` (~line 1275).
- [x] 3.7 Verify Phase 3: `npx jest --runInBand --testPathPattern="projects.routes|scheduling.routes|projects-network-flag-composition"` — all green.

---

## Phase 4 — FE: TasksPageBase + Nodos Page + Modal + Call Sites

> **Covers**: REQ-NTP-1, REQ-NTP-2, REQ-NTP-3, REQ-NTP-4, REQ-NTP-5, REQ-NTP-6, REQ-KIND-FILTER-2

*(Can run in parallel with Phase 2–3 after Phase 1 contract is frozen)*

- [x] 4.1 [RED] Write FE test for `TasksPageBase`: existing `SchedulingTasksPage` render snapshot/behavior must pass when rendered via `<TasksPageBase title="Tareas" />`. Must fail (component doesn't exist yet).
- [x] 4.2 [GREEN] Extract `src/pages/scheduling/SchedulingTasksPage/TasksPageBase.tsx` from `SchedulingTasksPage/index.tsx` (145 lines). Props: `{ title, kind?, modalDefaultMode?, projectPredicate?, columnsStorageKey? }`.
- [x] 4.3 [GREEN] Update `SchedulingTasksPage/index.tsx` to `<TasksPageBase title="Tareas" projectPredicate={p => !p.isNetworkProject} />` — byte-identical render, existing tests pin it.
- [x] 4.4 [GREEN] Create `src/pages/scheduling/SchedulingNodeTasksPage/index.tsx` as `<TasksPageBase title="Tareas Nodos" kind="network" modalDefaultMode="network" projectPredicate={p => p.isNetworkProject === true} columnsStorageKey="nodeTasks" />`.
- [x] 4.5 [GREEN] Add `kind?: 'customer' | 'network'` to `src/types/scheduling.ts` `TaskListFilter`. Add `kind` serialization to `buildFilterParams` in `src/api/scheduling.api.ts`. Add `isNetworkProject?: boolean` to `src/types/project.ts`.
- [x] 4.6 [RED] Write FE test for `CreateTaskModal` `defaultMode` prop: when `defaultMode='network'` → modal opens in network mode, toggle is hidden, NodeSelector visible. Must fail.
- [x] 4.7 [GREEN] Add `defaultMode?: 'customer' | 'network'` prop to `CreateTaskModal.tsx`. When present: initial `taskMode = defaultMode`, toggle hidden (static badge "Nodo RED"). Backward-compatible.
- [x] 4.8 [GREEN] Implement address prefill in `CreateTaskModal.tsx`: on `networkSiteId` change in network mode, prefill `address` from `useNetworkSites()` cache (`site.address ?? ''` + city). Ref-guard `filledForSite` mirrors `filledForCustomer` pattern (lines 122-130). Editable.
- [x] 4.9 [RED] Write FE test for `SchedulingCalendarPage` and `TicketDetailPage` call sites: `CreateTaskModal` receives `projects.filter(p => !p.isNetworkProject)`. Must fail.
- [x] 4.10 [GREEN] Update `SchedulingCalendarPage/index.tsx:331`: pass `projects.filter(p => !p.isNetworkProject)` to `CreateTaskModal`.
- [x] 4.11 [GREEN] Update `TicketDetailPage.tsx:225`: pass `projects.filter(p => !p.isNetworkProject)` to `CreateTaskModal`.
- [x] 4.12 [GREEN] Add lazy import + `<Route path="nodos" element={<RequirePermission permission="scheduling.read"><SchedulingNodeTasksPage /></RequirePermission>} />` to `src/App.tsx` (~line 245, scheduling block).
- [x] 4.13 Verify Phase 4: `npx vitest run --reporter=verbose` scoped to scheduling pages — all green.

---

## Phase 5 — FE: Settings Tab + Sidebar

> **Covers**: REQ-PROJ-NET-4 (FE side), REQ-NTP-1 (sidebar)

*(Can run in parallel with Phase 3)*

- [x] 5.1 [RED] Write FE test for `NetworkProjectsBody`: mirrors `RetirementProjectsBody.test.tsx` — renders project list, toggle calls `useUpdateProject` PATCH `{ isNetworkProject }`, respects `Can permission="scheduling.manage"`. Must fail.
- [x] 5.2 [GREEN] Create `src/pages/scheduling/settings/NetworkProjectsBody.tsx` — mirror of `RetirementProjectsBody.tsx`: `useProjects('all')` + `useUpdateProject` PATCH `{ isNetworkProject }`, `Can permission="scheduling.manage"` toggle with read-only fallback.
- [x] 5.3 [GREEN] Add tab `{ id: 'proyectos-red', label: 'Proyectos de red', content: <NetworkProjectsBody /> }` to `SchedulingSettingsPage.tsx` (~lines 11-18).
- [x] 5.4 [GREEN] Insert `{ to: '/admin/scheduling/nodos', label: 'Tareas Nodos' }` after Tareas entry in `Sidebar.tsx:136`.
- [x] 5.5 Verify Phase 5: `npx vitest run --reporter=verbose` scoped to settings + sidebar — all green.

---

## Phase 6 — Gates (orchestrator runs after all phases)

- [ ] 6.1 BE: `npx jest --runInBand` — full suite green, zero skips.
- [ ] 6.2 BE: `npx tsc --noEmit` — zero errors.
- [ ] 6.3 FE: `npx vitest run` — full suite green.
- [ ] 6.4 FE: typecheck (`npx tsc --noEmit` or equivalent) — zero errors.
- [ ] 6.5 Manual smoke: deploy BE → ops tag 2 network projects via `/admin/scheduling/settings` → Proyectos de red tab. Verify node modal lists exactly those 2; client modal excludes them.
