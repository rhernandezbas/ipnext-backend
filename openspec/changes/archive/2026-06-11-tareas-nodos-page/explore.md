# Exploration: Tareas Nodos Page (Backlog #40)

## Goal

New "Tareas Nodos" page identical to the Tareas page but scoped to `kind='network'` tasks. Key requirements:
1. "Añadir" opens node-task modal directly (no toggle)
2. Project select shows ONLY "Red - fibra" and "Red Wireless"
3. Those 2 projects must NOT appear in the client-task creation modal
4. sequenceNumber stays shared/auto-incremental with client tasks (single sequence)
5. Address loaded manually from NetworkSite (field confirmed: `address`, `city`)
6. Projects page: no changes needed
7. Seam awareness: #41 will add general statuses [open|closed|dismissed] to both lists

---

## Current State

### Backend

#### ScheduledTask model (`prisma/schema.prisma:1109-1227`)
- `sequenceNumber Int @unique @default(autoincrement())` — **single global sequence**, not kind-scoped. Both customer and network tasks share it. This is correct and must not change.
- `kind String @default("customer")` — already exists from #29 (`prisma/schema.prisma:1191`)
- `networkSiteId String?` + relation to `NetworkSite` — already exists (`prisma/schema.prisma:1192-1193`)
- No `status` field beyond `isClosed Boolean` — #41 seam

#### NetworkSite model (`prisma/schema.prisma:1504-1535`)
- Fields: `id`, `name`, `address String?`, `city String?`, `lat Float?`, `lng Float?`, `type`, `status`, `iclassNodeCode String?`, `uispSiteId String?`
- Address is MANUALLY loaded (no auto-geocoding)
- Back-relation `scheduledTasks ScheduledTask[]` exists

#### Project model (`prisma/schema.prisma:1065-1097`)
- `allowsEquipmentRetirement Boolean @default(false)` — the `#39` pattern flag
- No `isNetworkProject` flag yet — **this is the key design decision**
- Projects "Red - fibra" / "Red Wireless" are **NOT seeded** — they exist only in production data. The seed has no project entries by those names (verified: `prisma/seed.ts` has no project seeding).

#### ListTasks use case (`src/application/use-cases/ListTasks.ts:1-11`)
- Delegates to `SchedulingRepository.listTasks(filter?: TaskListFilter)`
- `TaskListFilter` (`src/application/dto/scheduling.dto.ts:120-132`) does **NOT** have a `kind` filter field. Adding it is required for the new page.
- `PrismaSchedulingRepository.listTasks` (`src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts:157-192`) has no `kind` WHERE clause — needs to be added.

#### ListProjects use case + route
- `GET /projects` accepts `?visible=true|false|all`
- `ListProjectsFilter` (`src/domain/ports/ProjectRepository.ts:19-21`) only has `visible?: boolean` — no kind/network filter
- `Project` entity (`src/domain/entities/project.ts:1-24`) has `allowsEquipmentRetirement: boolean` but no `isNetworkProject` field yet

#### CreateTask use case (`src/application/use-cases/CreateTask.ts:1-95`)
- Already branches on `data.kind`: network tasks validate `networkSiteId`, customer tasks validate `customerId + contractId`
- No project-kind validation exists — any project can be used for any task kind

#### #29 archive design (`openspec/changes/archive/2026-06-08-network-node-task/design.md`)
- All schema changes already shipped: `kind`, `networkSiteId`, `iclassNodeCode` on NetworkSite
- FE CreateTaskModal already has the toggle (`taskMode: 'customer' | 'network'`) and NodeSelector

### Frontend

#### SchedulingTasksPage (`src/pages/scheduling/SchedulingTasksPage/index.tsx`)
- Route: `/admin/scheduling/tasks` (registered in `App.tsx:255`)
- Permission gate: `scheduling.read` / `scheduling.write`
- State: `useTasksFilterUrl()` hook + `useFilteredTasks(backendFilter)`
- Projects come from `useProjects()` (all visible projects, no kind filter)
- `CreateTaskModal` receives all `projects` — no filtering by kind

#### CreateTaskModal (`src/pages/scheduling/SchedulingTasksPage/components/CreateTaskModal.tsx`)
- Has `taskMode: 'customer' | 'network'` toggle (segmented control, lines 90, 319-339)
- Network mode shows `<NodeSelector>` for site selection (line 407)
- Project select renders ALL `projects` passed via prop (lines 441-446) — **no filtering by mode**
- `canSave` branches on `taskMode` (lines 210-218): customer requires `customerId+contractId`, network requires `networkSiteId`

#### TaskListFilter type (`src/types/scheduling.ts:2-14`)
- No `kind` field — needs to be added for the new page to filter by `kind='network'`

#### buildFilterParams (`src/api/scheduling.api.ts:11-23`)
- No `kind` param — needs to be added

#### useTasksFilterUrl (`src/pages/scheduling/SchedulingTasksPage/hooks/useTasksFilterUrl.ts`)
- No `kind` in URL params — the new page's hook (or a new variant) needs to handle it

#### Routing + Sidebar
- Sidebar (`src/components/organisms/Sidebar/Sidebar.tsx:134-140`): scheduling section has Dashboard, Proyectos, Tareas, Calendar, Mapas, Archivar, Configuración
- App.tsx (`scheduling` routes block, lines 236-256`): no "nodos" route yet
- The new page needs a new route `/admin/scheduling/nodos` and a new sidebar entry

#### Projects page (`src/pages/scheduling/SchedulingProjectsPage.tsx`)
- Lists ALL projects from `useProjects()` — no change needed, network tasks still appear in task counts per the requirement

#### isClosed in the current filter
- `isClosed` is in `ListTasksFilterSchema` (BE) and `useCloseTask` hook (FE), but is NOT wired into `useTasksFilterUrl` or `TaskFilterBar` — it's a per-task toggle action only
- **#41 seam**: the `isClosed` BE field is the foundation for the upcoming open/closed/dismissed status. Adding `kind` to the filter schema now must not break the #41 work.

---

## Options Compared

### Design Decision 1: Project scoping for node tasks

**Option A: `isNetworkProject` flag on `Project` (pattern: `allowsEquipmentRetirement`)**
| | |
|---|---|
| Pros | Operator-configurable at runtime (no redeploy to add a 3rd network project). Consistent with `#39` pattern. Clean DB-first truth. Works for `CreateTask` validation (guard: "network task → only network projects"). |
| Cons | Requires migration (`ALTER TABLE "Project" ADD COLUMN "isNetworkProject" BOOLEAN DEFAULT false`). Seed or manual toggle needed in prod to tag the 2 existing projects. PATCH endpoint must accept the new field (same pattern as `allowsEquipmentRetirement`). |
| Effort | Low — mirrors `allowsEquipmentRetirement` exactly. 1 migration + 1 DTO field + 1 guard. |

**Option B: Static config mapping (hardcode titles in BE/FE)**
| | |
|---|---|
| Pros | Zero migration. Zero DTO change. Instant to implement. |
| Cons | Fragile: title changes in prod break the filter. Cannot add a 3rd network project without a code deploy. Violates "DB is source of truth" principle. |
| Effort | Very Low — but poor design. |

**Option C: Separate `projectKind` enum on `Project`**
| | |
|---|---|
| Pros | More expressive (could be `client | network | both`). |
| Cons | Over-engineering for 2 projects. Migration + DTO churn. `allowsEquipmentRetirement` is a boolean flag precedent for a reason. |
| Effort | Medium |

**Recommendation: Option A** — `isNetworkProject Boolean @default(false)` on `Project`, following the `allowsEquipmentRetirement` pattern exactly. Operator marks the 2 production projects via the Projects UI. CreateTask validates that network tasks use only network projects (and customer tasks use only non-network projects). The FE filters the project list by `isNetworkProject` based on context (customer modal: exclude isNetworkProject; node modal: only isNetworkProject).

### Design Decision 2: New page approach

**Option A: New dedicated route + page (`/admin/scheduling/nodos`)**
| | |
|---|---|
| Pros | Clean separation. Page title "Tareas Nodos". "Añadir" opens directly in network mode. Filter defaults to `kind=network`. No conditional logic in the existing page. |
| Cons | Minor duplication of SchedulingTasksPage structure. |
| Effort | Low — copy-compose of existing components with `kind='network'` hardcoded filter |

**Option B: Param-driven variant of SchedulingTasksPage (`?kind=network`)**
| | |
|---|---|
| Pros | Less code. |
| Cons | URL-based — users could manually remove the param and see mixed tasks. Sidebar entry would be confusing. "Añadir" button logic more complex. |
| Effort | Low but fragile |

**Recommendation: Option A** — new page with hardcoded `kind='network'` filter. Reuse all sub-components (`TaskFilterBar`, `TasksTableView`, `TasksKanbanView`, `CreateTaskModal`) as-is, just pass `kind='network'` to `useFilteredTasks` and `projects={networkProjects}` (filtered by `isNetworkProject`).

### Design Decision 3: `kind` filter in BE ListTasks

Currently `ListTasksFilterSchema` has no `kind` field. It must be added:
```ts
kind: z.enum(['customer', 'network']).optional(),
```
And `PrismaSchedulingRepository.listTasks` must add:
```ts
if (filter?.kind) where['kind'] = filter.kind;
```
This is additive and non-breaking. The existing Tareas page passes no `kind` → sees all tasks (current behavior preserved).

---

## Risks / Edge Cases

1. **"Red - fibra" / "Red Wireless" exact names unknown**: production DB may have title variants ("Red-Fibra", "Red Fibra"). The `isNetworkProject` flag removes this ambiguity — operator tags projects directly; no title-matching code needed.

2. **sequenceNumber gap concern**: `@default(autoincrement())` is a single Postgres sequence across all `ScheduledTask` rows. Adding node tasks creates gaps in the client-task number series. This is already the case since #29 shipped. The requirement explicitly says to keep it shared. No action needed.

3. **Projects page taskCounts**: `GET /projects` already returns `taskCounts` that includes ALL task kinds. If the BE is changed to add `kind` to the filter, the Projects page must NOT pass `kind` → correctly unchanged.

4. **#41 seam (open/closed/dismissed)**: #41 will add a `status` column to tasks and a status filter to both lists. The `kind` filter added here is orthogonal. The seam to watch: `useTasksFilterUrl` and `buildFilterParams` will both need updating in #41. The new page's URL hook (a thin wrapper over the shared hook) will need the same #41 update. Design for easy extension: keep `kind` as a fixed constant in the page, not in the URL params, so the URL hook for #40 is simpler.

5. **CreateTask guard — network tasks + network projects**: must validate that when `kind='network'`, `projectId` belongs to a network project. When `kind='customer'`, `projectId` must NOT be a network project. This requires the `CreateTask` use case to receive the project's `isNetworkProject` flag — either via the existing `projectLookup` (which returns the full `Project` entity) or a new dedicated lookup. The existing `projectLookup.findById` already works; the use case just needs to check `project.isNetworkProject`.

6. **NodeSelector address auto-fill**: NetworkSite has `address` and `city`. The node-task create modal should auto-fill `address` from the selected NetworkSite (same as the customer flow auto-fills from the contract). This requires a `useNetworkSite(id)` hook call when `networkSiteId` changes.

7. **Permission**: the new page reuses `scheduling.read` / `scheduling.write`. No new permission key is needed — the change is a filtered view, not a new capability.

---

## Recommendation

**Backend (additive, no breaking changes):**
1. Add `isNetworkProject Boolean @default(false)` to `Project` schema — migration only.
2. Add `isNetworkProject` to `ProjectRepository.UpdateProjectInput`, `UpdateProjectSchema` (PATCH-only, guarded by `scheduling.write` or `inventory.manage` — TBD, recommend `scheduling.write` since it's a scheduling concept, not inventory).
3. Add `isNetworkProject` to `Project` domain entity + Prisma mapper.
4. Add `kind` to `ListTasksFilterSchema` and `PrismaSchedulingRepository.listTasks`.
5. Add `kind` validation in `CreateTask.execute`: network tasks must use network projects, customer tasks must not.
6. `ListProjects` endpoint: optionally add `isNetworkProject` filter query param for the FE to fetch only network projects, or let FE filter client-side (simpler — project list is small).

**Frontend (additive, composing existing components):**
1. New page `SchedulingNodeTasksPage` at `/admin/scheduling/nodos` — copy-compose of `SchedulingTasksPage`, hardcode `kind='network'` filter, pass `projects={projects.filter(p => p.isNetworkProject)}` to the modal.
2. `CreateTaskModal` receives `defaultMode?: 'customer' | 'network'` prop — when `'network'`, hide the mode toggle and start in network mode.
3. `CreateTaskModal` already accepts `projects` prop — the Tareas page passes all projects; the Nodos page passes only network projects. No internal change to the modal.
4. Add `kind` to `buildFilterParams` in `scheduling.api.ts`.
5. Add `isNetworkProject` to the FE `Project` type.
6. Add sidebar entry "Tareas Nodos" under scheduling.
7. Add route `/admin/scheduling/nodos` to `App.tsx`.

---

## #41 Seams (Status: open | closed | dismissed)

Files that will be touched by BOTH #40 and #41:
- `src/application/dto/scheduling.dto.ts` (ListTasksFilterSchema — add `kind` in #40, add `status` in #41)
- `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts` (listTasks WHERE — add `kind` in #40, add `status` in #41)
- `src/types/scheduling.ts` (TaskListFilter — add `kind` in #40, `status` in #41)
- `src/api/scheduling.api.ts` (buildFilterParams — add `kind` in #40, add `status` in #41)
- `useTasksFilterUrl` or equivalent (add kind support in #40 page hook, add status in #41)
- `TaskFilterBar.tsx` (add status chips in #41 — the Nodos page's FilterBar will need the same)

Risk: merge conflicts between #40 and #41. Mitigate by keeping #40 changes strictly additive and non-overlapping (different filter keys).

---

## Open Questions

1. **Permission guard for `isNetworkProject` PATCH**: use `scheduling.write` (scheduling admin concept) or `inventory.manage` (existing pattern for `allowsEquipmentRetirement`)? Recommend `scheduling.write` since it's not inventory-related.
2. **Auto-fill address from NetworkSite in modal**: confirm whether the node-task modal should auto-fill address from `NetworkSite.address` (matches UX of customer flow). Needs a `GET /networking/sites/:id` call. Alternatively, address is always manually entered for node tasks (simpler for now).
3. **Projects page `isNetworkProject` UI**: should the Projects page show/edit the `isNetworkProject` flag (like it shows `allowsEquipmentRetirement`)? Needed for ops to tag production projects without DB access.
4. **Exact canonical titles of the 2 projects in prod**: "Red - fibra" and "Red Wireless" — confirm before the apply phase to know which projects to tag.

---

## Ready for Proposal

Yes. The design is clear: `isNetworkProject` flag (Option A) + new dedicated page (Option A). All affected files identified. No ambiguous architectural decisions remain beyond the 4 open questions above.
