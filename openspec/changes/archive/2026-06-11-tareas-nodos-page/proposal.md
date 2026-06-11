# Proposal: Tareas Nodos Page (Backlog #40)

## Intent

Operators need a dedicated "Tareas Nodos" page for `kind='network'` tasks: direct node-modal creation, project select limited to network projects, and those projects hidden from client-task creation. Today both kinds mix in one page and any project accepts any kind.

## Scope

### In Scope
- BE: `Project.isNetworkProject Boolean @default(false)` (additive migration), exposed in Project DTO/entity/mappers.
- BE: PATCH `isNetworkProject` guarded by `scheduling.manage` (mirror of #39's `inventory.manage` guard — `app.ts:1275`, `projects.routes.ts:122-127`).
- BE: `kind` in `ListTasksFilterSchema` + rawQuery (`scheduling.routes.ts:130-140`) + Prisma WHERE.
- BE: `CreateTask` guard — `kind='network'` requires `project.isNetworkProject=true`; `kind='customer'` requires `false`.
- FE: page `SchedulingNodeTasksPage` at `/admin/scheduling/nodos` + sidebar entry, gated `scheduling.read`/`scheduling.write` (RequirePermission/Can).
- FE: `CreateTaskModal` `defaultMode='network'` prop (no toggle); project lists filtered by `isNetworkProject` on both pages; address prefilled from cached `NetworkSite.address` (editable; no new endpoint).
- FE: sub-tab "Proyectos de red" in `SchedulingSettingsPage` (mirror `RetirementProjectsBody`), gated `scheduling.manage`.

### Out of Scope
- #41 statuses (open/closed/dismissed); `kind` stays out of URL params to minimize seam.
- Projects-page task listing changes (network tasks keep appearing; shared `sequenceNumber` untouched — single autoincrement, verified `schema.prisma:1109+`).
- Address auto-geocoding; UISP sync changes.

## Capabilities

### New Capabilities
- `network-tasks-page`: dedicated FE page for node tasks (route, sidebar, direct node modal, network-project select).

### Modified Capabilities
- `projects`: Project gains `isNetworkProject`; PATCH mutation requires `scheduling.manage`.
- `scheduling`: task list filterable by `kind`; CreateTask enforces project-kind match.

## Approach

Mirror #39's flag pattern exactly. Open questions resolved with evidence:
1. **Guard**: `requirePerm('scheduling','manage')` injected into `createProjectsRouter` as second optional guard, applied only when `isNetworkProject` in body. Key already exists (workflows RBAC).
2. **Address**: prefill from `useNetworkSites()` cache; dispatch already uses `networkSite.address` (`dispatchTaskToIClass.ts:117-118`), so task address is informational.
3. **Flag UI**: `NetworkProjectsBody` tab in `/admin/scheduling/settings` (pattern: `InventorySettingsPage` → `RetirementProjectsBody`).
4. **Prod titles**: irrelevant by design — ops tag projects post-deploy via the new tab.

## Wire Contract

- `GET /api/scheduling?kind=network` — `kind: 'customer'|'network'` optional; omitted ⇒ all (Tareas/Projects unchanged).
- Project DTO: `+ isNetworkProject: boolean`.
- `PATCH /api/projects/:id` body `{ "isNetworkProject": true }` → 403 without `scheduling.manage`.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| CreateTask guard breaks existing flows pre-tagging | Med | Customer guard only rejects flagged projects (all `false` initially ⇒ no-op until tagged) |
| #41 merge conflicts (shared filter files) | Med | Strictly additive keys; `kind` constant in page, not URL |
| Ops forget to tag prod projects | Med | Documented post-deploy step; empty modal select is visible signal |

## Rollback Plan

Revert code; column is additive with default `false` — no destructive migration. Flag untagged ⇒ behavior identical to today.

## Dependencies

- #29 shipped (`kind`, `networkSiteId`, NodeSelector) — confirmed in prod.

## Post-Deploy Steps

1. Tag "Red - fibra" and "Red Wireless" via Scheduling → Configuración → Proyectos de red.
2. Verify node modal lists only those 2; client modal excludes them.

## Success Criteria

- [ ] `/admin/scheduling/nodos` lists only network tasks; Añadir opens node modal directly.
- [ ] Network projects absent from client modal; only ones in node modal.
- [ ] PATCH `isNetworkProject` returns 403 without `scheduling.manage`; both layers gated.
- [ ] `sequenceNumber` remains single shared sequence; Projects page unchanged.
