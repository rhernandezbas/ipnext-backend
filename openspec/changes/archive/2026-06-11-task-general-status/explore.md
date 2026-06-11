# Exploration: task-general-status (Backlog #41)

## Goal

Add 3 general management states — `open`, `closed`, `dismissed` — INDEPENDENT of workflow
stages. Both customer and network tasks. Closed/dismissed tasks MUST NOT appear in the main
list view. Default/main view is always `open`. Filter with 4 options: open / closed / dismissed / todos.

---

## Current State — BE

### `isClosed` already exists (Boolean)

- **Schema**: `prisma/schema.prisma` line 1165 — `isClosed Boolean @default(false)` on `ScheduledTask`.
- **Entity**: `src/domain/entities/scheduling.ts` line 55 — `isClosed: boolean`.
- **Port**: `src/domain/ports/SchedulingRepository.ts` line 22 — `UpdateTaskInput.isClosed?: boolean`.
- **Filter**: `src/application/dto/scheduling.dto.ts` line 130 — `isClosed: z.enum(['true', 'false']).transform(...)`.
- **Prisma repo**: `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts`:
  - Line 89: `toTask` maps `row.isClosed ?? false`.
  - Line 184: `if (filter?.isClosed !== undefined) where['isClosed'] = filter.isClosed;`
  - Line 544: `if (data.isClosed !== undefined) update['isClosed'] = data.isClosed;`
- **In-memory repo**: `src/infrastructure/adapters/in-memory/InMemorySchedulingRepository.ts`
  - Line 69: `isClosed: false` in `NEW_FIELDS_DEFAULTS`.
  - Line 290: `if (filter.isClosed !== undefined) tasks = tasks.filter(t => t.isClosed === filter.isClosed);`
- **Route**: `src/infrastructure/http/routes/scheduling.routes.ts` line 139 — `isClosed: req.query['isClosed']` forwarded to `ListTasksFilterSchema`.
- **Test**: `src/__tests__/infrastructure/scheduling.isClosed.test.ts` — 12 tests covering `toTask`, `updateTask`, and `GET ?isClosed=` filtering. All pin `isClosed` as a boolean filter.

### What `isClosed` does today

`isClosed` is a **soft-close Boolean** — it closes the task outside the workflow stage.
Currently the `GET /api/scheduling` default (no `isClosed` param) returns ALL tasks including
closed ones. There is NO default exclusion.

**Key insight**: `isClosed: true` IS the future `status: 'closed'`. `isClosed: false` is the future `status: 'open'`. The `dismissed` state is entirely NEW.

### Activity log: `isClosed` already generates an event

`src/application/use-cases/computeUpdateTaskActivities.ts` line 51:
```ts
if (changed('isClosed')) events.push({ type: 'status_changed', actor, fromValue: prev.isClosed, toValue: data.isClosed });
```
This event type will need a parallel for `dismissed` state changes.

### Stage categories and overlap with general states

`StageCategory` enum: `nuevo | enProgreso | hecho` (schema line 447).

- `hecho` stages include both "Hecho" (success) AND "Anulado-Cancelado" (cancel) — confirmed by `scheduling.isClosed.test.ts` line 63.
- Stage-category is WORKFLOW progress (how far along the work is). General status is MANAGEMENT state (visible in lists vs archived).
- No stage currently implies `isClosed: true` automatically. The IClass closure loop sets stage to a mapped stage (e.g. "Hecho") but does NOT set `isClosed`.
- **No overlap problem**: a task can be `hecho` in workflow AND `open` (not yet management-closed). The two dimensions are orthogonal.

### `kind` filter — from #40 (origin/main)

`ListTasksFilterSchema` on `origin/main` already has:
```ts
kind: z.enum(['customer', 'network']).optional(),  // line 132
```
The `status` param for #41 is a **separate additive field** — confirmed by the seam note in
`openspec/changes/archive/2026-06-11-tareas-nodos-page/specs/scheduling/spec.md`:
> "Seam note: `#41` will add `status` filter to `ListTasksFilterSchema` and `buildFilterParams`.
>  The `kind` key added here is orthogonal."

### IClass dispatch/closure crons

- **`listTasksInIClassStage`** (`PrismaSchedulingRepository.ts` line 667): queries tasks by stage code `registered_in_iclass`. Does NOT filter by `isClosed`. A dismissed task that was sent to IClass would still appear here.
  - **Risk**: if a dismissed task is in-flight to IClass, the reconcile/autocomplete crons will still try to close it. This needs a guard or a policy decision: "dismiss aborts IClass dispatch reconciliation".
- **`IngestClosedServiceOrders`** uses `findTaskBySequenceNumber` (line 194 of `IngestClosedServiceOrders.ts`) — looks up by SO `codigo`. This will still match a dismissed task. Decision needed: should IClass closure ignore dismissed tasks?
- **`TaskAutocompleteScheduler`** (`bootstrapTaskAutocomplete.ts`) is driven by `ReprocessClosureSideEffects`, which operates on the IClass SO mirror — not directly on the scheduling repo filter. Impact is indirect only.

---

## Current State — FE

### `isClosed` is a display-only boolean on the FE today

- **Types**: `src/types/scheduling.ts` line 111 — `isClosed?: boolean`.
- **TaskHeader**: shows a "Cerrada" badge (`task-closed-badge`) when `task.isClosed === true` (line 142). Has a kebab menu entry "Cerrar tarea" / "Reabrir tarea" (line 185) that calls `PUT /:id { isClosed: !task.isClosed }`.
- **TasksTableView**: shows a `closedRow` CSS class and "Cerrada" badge in the row (lines 405, 409). Has a "Cerrar" action per row (line 502) that calls `closeTask.mutateAsync({ id, isClosed: true })`.
- **`useTasksFilterUrl`**: does NOT include `isClosed` in the URL filter. The filter object has no `isClosed` key.
- **`buildFilterParams`** (`api/scheduling.api.ts`): does NOT serialize `isClosed`. No `isClosed` param is ever sent to the backend from the main list.
- **Calendar** (`SchedulingCalendarPage`): passes the URL filter through `useTasksForCalendar` → `useFilteredTasks` — no `isClosed` forced.
- **SchedulingArchivePage**: stub, hardcoded data, NOT connected to real `isClosed` queries.
- **Dashboard**: does NOT query tasks directly (stub counts from `DashboardStat` singleton).
- **Projects page**: does NOT call `useFilteredTasks` directly.
- **Tickets**: task is linked via FK `ticketId` but tickets page does NOT list tasks directly.

### `TasksPageBase` (#40)

New shared base component at `src/pages/scheduling/SchedulingTasksPage/TasksPageBase.tsx`.
Both Tareas and Tareas Nodos pages use it. `kind` is a PAGE constant injected at construction
(not in URL). The `status` filter for #41 must plug in the same way — either as URL state
(user-editable, in `useTasksFilterUrl`) or as a page constant (locked). User requirement says
it IS user-selectable ("a filter with the 3 states + todos") — so it goes into URL state and
into `TaskFilterBar`, just like `priority`, `partnerId`, etc.

---

## Options for the Data Model

### Option A — Repurpose `isClosed` + add `isDismissed` (two Booleans)

**What**: Keep `isClosed Boolean @default(false)`. Add `isDismissed Boolean @default(false)`.
Filter: `status = open (isClosed=false AND isDismissed=false) | closed (isClosed=true) | dismissed (isDismissed=true) | todos`.

| | Pros | Cons |
|---|---|---|
| DB | No migration risk on `isClosed` (column already exists) | Two columns for one semantic concept. Constraint: both cannot be true at once |
| App | `isClosed` test suite stays green (no rename) | All `isClosed` callers need re-audit; derived `status` computed in app layer |
| FE | Existing badge/close button work as-is | FE must learn both fields |

**Effort**: Medium.

### Option B — New `generalStatus` enum column, deprecate `isClosed`

**What**: Add `generalStatus String @default("open")` (values: `open | closed | dismissed`).
Keep `isClosed` as a **read-only derived Boolean** (no longer a first-class setter) for one
migration cycle, then drop it in a later change.

| | Pros | Cons |
|---|---|---|
| DB | Single source of truth for status | Migration: add column + backfill `isClosed=true → closed`. Must keep both in sync during transition |
| App | Clean domain model. `UpdateTaskInput.isClosed` replaced by `status`. One field to filter | `isClosed` setter in `UpdateTask`/route must be removed or guarded. Breaking change to existing API contract (`PUT { isClosed: true }`) |
| FE | One field. Filter/badge/button all reference `status` | Close button becomes `PUT { generalStatus: 'closed' }`. Requires FE update |

**Effort**: Medium-High (migration + API change + test rewrites).

### Option C — New `generalStatus` enum, keep `isClosed` as a FACADE

**What**: Add `generalStatus String @default("open")`. `isClosed` becomes a computed alias:
`isClosed = generalStatus === 'closed'`. Setter `PUT { isClosed: true }` silently maps to
`generalStatus = 'closed'`. No breaking change to the API or existing tests.

| | Pros | Cons |
|---|---|---|
| DB | Single source of truth. Clean domain going forward | Need a virtual/computed field or adapter-level translation |
| App | Backward compat: `PUT { isClosed: true }` still works. Test suite stays green | `toTask` mapper must derive `isClosed` from `generalStatus`. Slightly more complex |
| FE | Can ship incrementally: badge + close button unchanged on Day 1. Add `status` filter on Day 2 | Two representations in the interim |

**Effort**: Medium. The cleanest long-term option.

---

## Recommendation

**Option C** — new `generalStatus String @default("open")` column with facade backward compat.

Reasoning:
1. User says "open ya se crea y closed ya está creo que también" — the existing `isClosed` behavior covers `open/closed` exactly. Only `dismissed` is new.
2. Adding a third Boolean (`isDismissed`) creates a constraint violation risk and requires coordinated two-field updates. An enum column is semantically cleaner.
3. The facade keeps `scheduling.isClosed.test.ts` (12 tests) green without rewriting them, while the new domain entity uses `generalStatus`.
4. The filter becomes a single `status` param — no complex Boolean combinations.
5. Migration is safe: backfill `isClosed=true → generalStatus='closed'`, `isClosed=false → 'open'`. Drop `isClosed` column in a follow-up change (or leave as a DB-level generated column).

**Column name**: `generalStatus` avoids collision with the many existing `status` columns in other models and is explicit about scope.

---

## Surfaces Inventory — What must filter `open` by default

| Surface | Current behavior | What changes in #41 |
|---|---|---|
| `GET /api/scheduling` (no params) | Returns ALL tasks (closed + open) | Must default to `status=open` (exclude closed+dismissed) OR the FE must always send `?status=open` |
| `TasksPageBase` (Tareas + Tareas Nodos) | `useFilteredTasks(backendFilter)` — no status param | Must default `status=open` in URL state and send it always |
| `useTasksFilterUrl` | No `status`/`isClosed` in URL | Add `status` to URL filter; default `'open'` |
| `buildFilterParams` (FE) | No `isClosed` serialized | Add `status` serialization |
| `TaskFilterBar` | Priority / partner / assignee / stage filters | Add 4-option status selector: `open | closed | dismissed | todos` |
| `SchedulingCalendarPage` | No status filter forced | Should also default to `open` (closed/dismissed tasks should not appear in calendar) |
| `listTasksInIClassStage` (IClass cron) | Returns all tasks in flight stage | Should probably STILL include dismissed tasks to properly complete IClass closure side-effects even if dismissed (policy to confirm) |
| `SchedulingArchivePage` | Stub data | Will eventually become the `closed+dismissed` view |
| Dashboard counters | Stub / no real task queries | N/A for this change |
| Ticket task link | Task stored by FK, no listing | N/A |

**Default behavior decision**: The user says "the main view is ALWAYS open". Two valid approaches:
  - **BE-default**: `GET /api/scheduling` with no `status` param returns only `open` tasks. Risk: breaks IClass crons and any other callers that rely on the unfiltered list.
  - **FE-default**: `GET /api/scheduling` is unchanged (returns all). FE always sends `?status=open` from the main list pages. The "todos" option sends no status param (or explicit `all`).
  - **Recommendation**: **FE-default** is safer for existing integrations. The IClass crons call `listTasksInIClassStage` (a separate query path), not `listTasks`. The BE filter already supports `isClosed` — adding `status` is purely additive. The FE sending `?status=open` as the default preserves backward compat.

---

## Permissions for Close / Dismiss

- **Existing**: `isClosed` toggle is behind `scheduling.write` (implied by `PUT /:id` route which requires `auth` but no dedicated permission).
- **Recommendation**: `close` and `dismiss` should require a dedicated permission or at minimum `scheduling.write`. `dismiss` is more destructive (hides work permanently) so consider `scheduling.close` (close + reopen) vs `scheduling.dismiss` (dismiss + un-dismiss). Or keep both behind `scheduling.write` for simplicity in this change.
- **Tickets pattern**: CloseTicket checks `tickets.close` permission. Follow the same pattern.

---

## Risks

1. **`isClosed` facade complexity**: `toTask` mapper and `updateTask` DB writes must stay consistent — `generalStatus` is the DB truth; `isClosed` is derived. A bug here silently corrupts the representation.
2. **IClass crons ignoring dismissed tasks**: if a task is dismissed while in the `registered_in_iclass` stage, the closure cron will still try to reconcile it. Policy needed: probably "IClass closure ignores dismissed tasks" (don't move their stage, don't post comments). Requires filtering by `generalStatus != 'dismissed'` in `listTasksInIClassStage`.
3. **`status_changed` activity event**: the existing event uses `fromValue: prev.isClosed, toValue: data.isClosed` (booleans). With `generalStatus` enum the payload becomes string labels — existing activity feed items already persisted with boolean values will display differently. Low risk (audit trail only, no functional impact).
4. **Calendar default filter**: if Calendar does NOT default to `status=open`, closed/dismissed tasks appear on the calendar. This is probably wrong UX — but Calendar uses `from`/`to` date filters so tasks without dates don't appear anyway. Still, address this.
5. **`openspec` seam conflicts**: `scheduling.dto.ts`, `PrismaSchedulingRepository.ts`, `SchedulingRepository.ts`, `scheduling.ts` (FE types), `scheduling.api.ts`, `useTasksFilterUrl.ts` were all touched by #40. Merge carefully.
6. **Existing `isClosed` tests** (12 tests in `scheduling.isClosed.test.ts`): under Option C they remain valid as long as the facade maps correctly. Under Option B they must be rewritten.

---

## Open Questions

1. **BE default vs FE default**: should `GET /api/scheduling` (no params) return all tasks or only `open` tasks? Recommendation above is FE-default — confirm.
2. **IClass dismissed policy**: should a dismissed task that's in-flight in IClass be excluded from the closure reconcile loop? (Probably yes — no point moving a dismissed task's stage.)
3. **Permission granularity**: `scheduling.write` covers close+dismiss, or dedicated `scheduling.close` and `scheduling.dismiss`?
4. **`dismissed` undo/reopen**: can a dismissed task be un-dismissed (set back to `open`)? User should confirm.
5. **SchedulingArchivePage**: should it become the permanent home for `closed+dismissed` tasks (replacing the stub), or is that a separate change?
6. **Calendar**: force `status=open` by default in Calendar, or leave it as-is (tasks without dates don't show regardless)?
7. **`isClosed` column drop timeline**: drop `isClosed` in the same change or leave as a compatibility alias?

---

## Ready for Proposal

Yes. The domain model is clear (Option C with `generalStatus` enum + facade). The filter pipeline
(BE `status` param, FE `useTasksFilterUrl` + `buildFilterParams` + `TaskFilterBar`) is well-understood.
The main risks are the IClass dismissed-task policy and the BE vs FE default decision — both are
answerable before spec. Recommend confirming those two open questions before writing specs.
