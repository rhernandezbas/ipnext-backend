# Exploration: reconcile-page-and-audit-reset (backlog #35)

Two-part change. **Part 1** (urgent, small): a data-only migration to reset burned
`auditAttempts` so #34 (map-reduce audit) can rescue the degenerated OS. **Part 2**
(feature): a Reconcile page listing in-flight tasks with per-task (1x1) + batch reconcile.

---

## Q1 — Audit reset migration

**Table + columns (confirmed):** `prisma/schema.prisma:620-684` — `model IClassServiceOrder`
has `auditDone Boolean @default(false)` (line 682) and `auditAttempts Int @default(0)`
(line 683), plus `lastAuditAttemptAt DateTime?` (684).

**#20 template (confirmed):** `prisma/migrations/20260607010000_remediate_audit_full_context/migration.sql`
— a pure data UPDATE, no schema change:
```sql
UPDATE "IClassServiceOrder" SET "auditDone" = false, "auditAttempts" = 0
WHERE "auditDone" = true;
```
That one reset *done* rows. Ours mirrors it but targets the *burned* rows:
```sql
UPDATE "IClassServiceOrder" SET "auditAttempts" = 0
WHERE "auditDone" = false AND "auditAttempts" >= 3;
```
(Only reset `auditAttempts`; `auditDone` is already false for these, no need to touch it.)

**Latest migration timestamp:** `20260609000000_iclass_closure_config`. The new migration
must be **after** it — e.g. `20260610000000_reset_burned_audit_attempts`.

**maxAuditAttempts default = 3 (confirmed):** declared in three use cases as
`const DEFAULT_MAX_AUDIT_ATTEMPTS = 3` / `const MAX_AUDIT_ATTEMPTS = 3`:
- `IngestClosedServiceOrders.ts:34`
- `ReprocessClosureSideEffects.ts:8`
- `GetPendingSideEffectsCount.ts:4`, `GetPendingSideEffectsList.ts:7`

**Where the filter lives (confirmed):** `PrismaClosedServiceOrderRepository.ts:278-304`
(`listPendingSideEffects`) and `:306-338` (`listPendingSideEffectsWithTask`). Both use:
```ts
{ auditDone: false, auditAttempts: { lt: maxAuditAttempts } }
```
In-memory mirror: `InMemoryClosedServiceOrderRepository.ts:63,74`. This is exactly the
clause that **excludes** the burned rows (`auditAttempts >= 3`), so resetting to 0
re-includes them in #34's reprocess sweep. **No code change needed for Part 1** — the
migration alone re-arms the loop. The migration is idempotent/harmless on re-run (once
#34 succeeds, rows flip to `auditDone=true` and no longer match `auditDone=false`).

---

## Q2 — Per-task reconcile (1x1)

**Current loop:** `BackfillClosedServiceOrders.execute()` (`BackfillClosedServiceOrders.ts:59-82`):
1. `listTasksInIClassStage('registered_in_iclass')` → all in-flight tasks
2. per task: `iclass.listServiceOrders({ updatedDateBegin, updatedDateEnd, serviceOrderCode: String(task.sequenceNumber) })`
3. per returned summary: `ingest.processSummary(s, counts)` (public, reusable —
   `IngestClosedServiceOrders.ts:164`), which mirrors the SO and transitions the task.

**Single-task path (sketch):** extract the per-task body into a reusable method and add a
new use case `ReconcileTaskClosure`:
```ts
class ReconcileTaskClosure {
  constructor(iclass, scheduling, ingest, opts) {}
  async execute(taskId: string): Promise<IngestClosedCounts> {
    const counts = emptyClosedCounts();
    const task = await scheduling.getTaskById(taskId);   // need a fetch-by-id
    if (!task) throw new TaskNotFoundError(taskId);
    const now = this.now();
    const begin = new Date(now.getTime() - this.lookbackDays * DAY_MS);
    const summaries = await iclass.listServiceOrders({
      updatedDateBegin: begin, updatedDateEnd: now,
      serviceOrderCode: String(task.sequenceNumber),
    });
    for (const s of summaries) await ingest.processSummary(s, counts);
    return counts;
  }
}
```
Cleanest refactor: pull the loop body of `BackfillClosedServiceOrders` into a private
`reconcileOne(task, begin, now, counts)` and have both the batch use case and the new
single use case call it (DRY). `IngestClosedCounts` shape: `{ mirrored, transitioned,
skippedNotClosed, skippedNotOurs, skippedUnchanged, errored, failed }`
(`IngestClosedServiceOrders.ts:37-48`, `emptyClosedCounts` :359).

**Sync vs 202:** a single task = **one** `iclass.listServiceOrders` call (fast, no
throttle loop, no Ollama on the hot path — audit is a side-effect re-fired later by the
reprocess scheduler). **Run it synchronously, return 200** with the counts (e.g.
`{ mirrored, transitioned }` → FE shows "cerrada" / "sigue abierta"). No scheduler, no
advisory lock needed — the batch path keeps using `BackfillScheduler` (202) because it
loops ~78 tasks with 350ms throttle (timeout risk); the 1x1 path has neither.

**Open item:** `getTaskById` — `SchedulingRepository` likely already has a fetch-by-id
(the FE links to `/admin/scheduling/tasks/:id`); confirm the exact method name during
design. If absent, add a minimal `getTaskById(id): Promise<ScheduledTask | null>`.

---

## Q3 — In-flight list endpoint

**`listTasksInIClassStage` (confirmed):** port `SchedulingRepository.ts:92`, Prisma impl
`PrismaSchedulingRepository.ts:665-673` (`where: { stage: { is: { code: stageCode } } }`,
`orderBy createdAt desc`, returns `ScheduledTask[]` via `toTask`). In-memory:
`InMemorySchedulingRepository.ts:506`.

**Return shape:** full `ScheduledTask[]` (`domain/entities/scheduling.ts:6+`). Fields the
FE list needs are all present: `id` (:7), `sequenceNumber` (:8), `title` (:9),
`customerName` (:31), `customerCode` (:36), `iclassOrderCode` (:73), `stageId` (:12).

**Is there an endpoint exposing in-flight tasks today?** **No.** The closure router
(`iclass-closure.routes.ts`) exposes `pending-list` (:141) but that lists SOs with
*pending side-effects* (different concept — already-mirrored SOs missing comment/inventory/audit),
NOT the in-flight tasks awaiting closure. We need a **new GET**, e.g.
`GET /closure/in-flight` (or `/closure/reconcile/list`), gated by `requireIClassManage`,
backed by a thin use case `ListInFlightTasks` that calls `listTasksInIClassStage(
'registered_in_iclass')` and maps to a DTO (id, sequenceNumber, title, customerName,
customerCode, iclassOrderCode). **Do NOT return raw `ScheduledTask`** (CLAUDE.md rule —
map to DTO).

**Existing closure routes (confirmed):** `iclass-closure.routes.ts`:
- `POST /closure/backfill` (:100) → 202 via `BackfillScheduler.triggerNow()` (the batch
  "reconcile all" — what the new page's "Reconciliar todas" button reuses).
- Wired in `app.ts:1250` (`createIClassClosureRouter(...)`), `backfillScheduler` passed at
  `app.ts:1255`. New deps (ReconcileTaskClosure, ListInFlightTasks) thread through the same
  factory signature.

**New endpoints to add:**
1. `GET  /closure/in-flight`            → list in-flight tasks (DTO) — for the page table
2. `POST /closure/reconcile/:taskId`    → single-task reconcile, **200 sync** with counts
   ("reconciliar" per row). Batch reuses existing `POST /closure/backfill` (202).

---

## Q4 — FE page (#31/#32 precedent)

**Precedent (confirmed):**
- Page: `ClosurePendingPage.tsx` — standalone, route `/admin/scheduling/iclass/closure/pending`,
  wrapped in `<RequirePermission permission="iclass.manage">`, hosts `<ClosureProgressTable />`.
- Table: `ClosureProgressTable.tsx` — `usePendingList()`, renders one row per item with a
  `TaskCell` linking to `/admin/scheduling/tasks/:id`, `EmptyState`, polling.
- Hook: `usePendingList` / `usePendingCount` in `hooks/useIClassClosure.ts` — TanStack Query
  with **stop-at-empty `refetchInterval`** (5s while items > 0, then `false`).
- API: `api/iclassClosure.api.ts` — `iclassClosureApi` object; `ClosurePendingItem`,
  `ClosurePendingList`, `BackfillTriggerResult` types.
- Route mount: `App.tsx:117-119` (lazy import) + `App.tsx:239` (the `<Route>` under
  `scheduling`, gated `iclass.manage`).
- Existing backfill button + banners: `IClassClosureFlagBody.tsx:140-177` — the "Reconciliar
  tareas pendientes" card with `useRunClosureBackfill()` (202, queued banners). This is the
  **batch** trigger; the new page's "Reconciliar todas" reuses this same mutation/endpoint.

**New FE to build (mirror the precedent):**
1. `ReconcileInFlightPage.tsx` — standalone, route
   `/admin/scheduling/iclass/closure/reconcile`, gated `iclass.manage`.
2. `InFlightTasksTable.tsx` — one row per in-flight task (#sequenceNumber, title,
   customerName, iclassOrderCode/stage), a per-row **"Reconciliar"** button (calls
   `POST /closure/reconcile/:taskId`, 200 sync → on success the row is refetched and, if it
   closed, drops out of the list) + a header **"Reconciliar todas"** button (reuses
   `useRunClosureBackfill` 202).
3. Hooks in `useIClassClosure.ts`: `useInFlightTasks()` (query, optional polling) +
   `useReconcileTask()` (mutation, invalidates the in-flight query on success).
4. API in `iclassClosure.api.ts`: `inFlightList()` GET + `reconcileTask(taskId)` POST;
   `InFlightTask` / `InFlightTaskList` types.
5. `App.tsx`: lazy import + `<Route path="iclass/closure/reconcile" ...>` (gate iclass.manage).
6. Add a Link to the new page from `IClassClosureFlagBody.tsx` near the backfill card
   (analogous to the existing "Quedan N pendientes" link to the pending page).

---

## Q5 — Tests to extend

**BE:**
- `src/__tests__/application/BackfillClosedServiceOrders.test.ts` — `setup()` builds the full
  in-memory rig (InMemoryIClassClient, InMemorySchedulingRepository, InMemoryStageRepository,
  InMemoryClosedServiceOrderRepository, ...). Reuse this rig for a new
  `ReconcileTaskClosure.test.ts` (seed one in-flight task, assert single-task reconcile).
- `src/__tests__/infrastructure/iclass-closure.routes.test.ts` — extend for the new
  `GET /closure/in-flight` (list) and `POST /closure/reconcile/:taskId` (200 sync) routes,
  including the `requireIClassManage` gate.
- `src/__tests__/infrastructure/closedServiceOrderRepo.sideEffects.test.ts` — has fixtures
  with `auditAttempts: 2` etc.; reference for the `listPendingSideEffects` filter behavior.
- `src/__tests__/infrastructure/InMemorySchedulingRepository.test.ts` — already tests
  `listTasksInIClassStage` by code (T-06); reference for the in-flight list use case test.
- Migration: no test runner for data migrations; follow the #20 pattern (raw SQL file). The
  `getPendingSideEffects*` tests already cover the `< maxAuditAttempts` boundary that the
  reset re-arms.

**FE:**
- `src/__tests__/scheduling/ClosurePendingPage.test.tsx` — template for the new
  `ReconcileInFlightPage.test.tsx`.
- `src/__tests__/scheduling/settings/ClosureProgressTable.test.tsx` — template for the new
  `InFlightTasksTable.test.tsx` (rows, empty state, per-row button).
- `src/__tests__/scheduling/settings/IClassClosureFlagBody.test.tsx` — B3.3 already asserts
  the Link to the pending page; mirror it for the new reconcile-page link.

---

## Approaches

1. **Two split deliverables (recommended)** — ship Part 1 (migration) first as a tiny PR,
   then Part 2 (page + endpoints) separately.
   - Pros: Part 1 unblocks #34's rescue immediately with near-zero risk; clean review.
   - Cons: two PRs.
   - Effort: Part 1 = Low; Part 2 = Medium.

2. **Single combined PR** — both parts together.
   - Pros: one review cycle.
   - Cons: couples an urgent 5-line migration to a multi-file feature; delays the rescue.
   - Effort: Medium.

3. **Reuse batch use case with an optional `taskId` param** (instead of a new use case).
   - Pros: less new code.
   - Cons: `BackfillClosedServiceOrders` would carry two responsibilities (loop-all vs
     single) and two return contracts (202 vs 200); muddier. Prefer a thin
     `ReconcileTaskClosure` that shares a private `reconcileOne` helper.
   - Effort: Low but worse cohesion.

## Recommendation

Approach **1** (split). Part 1 is a one-file data migration `20260610000000_reset_burned_audit_attempts`
— no code, ships now. Part 2: new `ReconcileTaskClosure` use case (shares `reconcileOne`
with the batch backfill), `ListInFlightTasks` use case + DTO, two new routes (GET list,
POST :taskId 200-sync), and the FE page mirroring the `ClosurePendingPage` precedent.

## Risks / unknowns

- `getTaskById` on `SchedulingRepository` — confirm the exact existing method (FE already
  routes to `/tasks/:id`, so a fetch likely exists). If absent, add a minimal one.
- The new migration MUST sort after `20260609000000`; use `20260610000000_…`.
- Idempotency of single-task reconcile: relies on `processSummary` being idempotent — it
  is (the batch backfill doc-comment at `BackfillClosedServiceOrders.ts:33-37` states so;
  upsert is replace-on-rerun per `PrismaClosedServiceOrderRepository.ts:74-162`).
- DTO discipline: the in-flight list and reconcile responses must be DTOs, never raw
  `ScheduledTask`/Prisma rows (CLAUDE.md hard rule).
- 1x1 reconcile is sync (200) — fine for one IClass call, but if a task's SO is older than
  the 29-day lookback cap it won't be found (same limitation as the batch; surface a
  "no se encontró cierre reciente" message).

## Ready for Proposal

**Yes.** Tell the user: split into two deliverables — Part 1 is a trivial data migration
that re-arms #34's audit rescue (ship immediately, near-zero risk); Part 2 is the reconcile
page (new `ReconcileTaskClosure` + `ListInFlightTasks` use cases, two BE routes, FE page
mirroring `ClosurePendingPage`). Recommend proceeding to proposal/spec for Part 2 and a
standalone fast-track for Part 1.
