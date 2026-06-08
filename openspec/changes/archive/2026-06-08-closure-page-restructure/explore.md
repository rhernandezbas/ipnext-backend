# Exploration: closure-page-restructure (#31)

## Current State

### FE Page Structure

The settings area is a two-level tab system:

**Level 1** — `SchedulingSettingsPage.tsx` (`src/pages/scheduling/SchedulingSettingsPage.tsx:11-17`)
Tabs: Categorías | Prioridades | Estados | Plantillas | **IClass** | Gestión Real
Tab `iclass` renders `<IClassSettingsBody />`.

**Level 2** — `IClassSettingsBody.tsx` (`src/pages/scheduling/settings/IClassSettingsBody.tsx:9-13`)
```ts
const SUB_TABS = [
  { id: 'integracion', label: 'Integración',        content: <IClassFlagBody /> },
  { id: 'catalogo',    label: 'Catálogo',            content: <IClassSoTypesCatalogBody /> },
  { id: 'mapeo',       label: 'Mapeo de proyectos',  content: <IClassProjectMappingBody /> },
  { id: 'cierre',      label: 'Cierre de OS',        content: <><IClassClosureFlagBody /><IClassResultCodeMappingBody /></> },
];
```

The `cierre` sub-tab currently renders BOTH `IClassClosureFlagBody` and `IClassResultCodeMappingBody` inline as a fragment.

### IClassClosureFlagBody sections (in render order)

`src/pages/scheduling/settings/IClassClosureFlagBody.tsx`:
1. **Cierre automático de OS** (lines 94-124) — main `iclass-closure-loop` toggle
2. **Reconciliar tareas pendientes** (lines 132-145) — `POST /closure/backfill` button
3. **Auditoría de IA** (lines 163-189) — `iclass-audit` toggle (inside `<Can permission="iclass.manage">`)
4. **Auto-completado de tareas** (lines 191-217) — `task-autocomplete` toggle (inside `<Can>`)
5. **Reprocesar side-effects pendientes** (lines 219-256) — `iclass-closure-reprocess` toggle + `POST /closure/reprocess` button + pending count badge (inside `<Can>`)

### The "mapeo de estado" component

`IClassResultCodeMappingBody` (`src/pages/scheduling/settings/IClassResultCodeMappingBody.tsx`) is the mapping component. It maps IClass closure result codes (e.g. "Instalacion Completa Fibra") to workflow stages. When an OS closes with that result code, the linked task moves to the mapped stage. This is the IClass result-code→stage mapping (NOT an SO-type mapping). It is mounted directly inside the `cierre` sub-tab fragment — no standalone route. The `IClassSoTypesCatalogBody` in the `catalogo` sub-tab is separate (SO types catalog, not closure mapping).

### Navigation/Tab mechanism

Tab navigation uses hash-based deep-linking at Level 1 (line 31-33 of SchedulingSettingsPage). Level 2 (`IClassSettingsBody`) uses local state only — no hash sync yet. Adding a new sub-tab means adding an entry to the `SUB_TABS` array in `IClassSettingsBody.tsx`.

---

## Backend: Data Sources for the Progress Table

### listPendingSideEffects — port + return shape

`ClosedServiceOrderRepository.listPendingSideEffects(maxAuditAttempts)` returns `PendingClosureSideEffects[]`:
```ts
// src/domain/ports/ClosedServiceOrderRepository.ts:7-18
interface ClosureSideEffectState {
  commentPosted: boolean;
  inventoryBuilt: boolean;
  auditDone: boolean;
  auditAttempts: number;
}
interface PendingClosureSideEffects extends ClosureSideEffectState {
  iclassId: string;
  scheduledTaskId: string | null;
}
```
This is the ONLY existing method returning the list. `GetPendingSideEffectsCount` calls it but discards the items, returning only `{ pending: number }`.

### Existing endpoint — count only

`GET /api/admin/iclass/closure/reprocess/pending-count`
(`src/infrastructure/http/routes/iclass-closure.routes.ts:116-122`)
Returns `{ pending: number }`. There is NO existing endpoint that returns the full list with per-SO breakdown.

### Task flags (#14)

`ScheduledTask` entity (`src/domain/entities/scheduling.ts:62-65`) has:
```ts
closureCommentDone:        boolean;
closureAuditDone:          boolean;
closureHasDeviceInventory: boolean;
```
These are set by `IngestClosedServiceOrders.ts` via `scheduling.markClosureCompleteness(taskId, {...})`.

`sequenceNumber` IS part of `ScheduledTask` and IS mapped in `PrismaSchedulingRepository.toTask()` (line 54). It is also in the FE type `ScheduledTask` (`src/types/scheduling.ts:63`). However, it is NOT in the existing FE `ScheduledTask` type alongside the closure flags — those three flags are not present in the FE type at all.

The task flags and the side-effect tracker on `IClassServiceOrder` track the same completion facts from two angles:
- `IClassServiceOrder.commentPosted/inventoryBuilt/auditDone/auditAttempts` — on the mirrored OS (drives reprocess)
- `ScheduledTask.closureCommentDone/closureAuditDone/closureHasDeviceInventory` — on the task (drives the task detail UI)

The progress table will use the SO side (`listPendingSideEffects`) since that's what drives the pending list. To show the task link (title, sequenceNumber), a JOIN to the task via `scheduledTaskId` is needed.

---

## New BE Endpoint Shape

A new use case `GetPendingSideEffectsList` analogous to `GetPendingSideEffectsCount` but returning the full list joined with task info:

```
GET /api/admin/iclass/closure/reprocess/pending-list
Guard: auth + requireIClassManage
```

Response shape:
```ts
{
  items: Array<{
    iclassId: string;
    scheduledTaskId: string | null;
    // from IClassServiceOrder side-effect tracker:
    commentPosted: boolean;
    inventoryBuilt: boolean;
    auditDone: boolean;
    auditAttempts: number;
    // joined from ScheduledTask (null when scheduledTaskId is null):
    task: {
      id: string;
      sequenceNumber: number;
      title: string;
    } | null;
  }>;
  total: number;
}
```

The `ClosedServiceOrderRepository.listPendingSideEffects()` already returns `scheduledTaskId`. The new use case would call it, then batch-fetch the tasks by their ids from `SchedulingRepository.findManyByIds()` (a new method, or a one-by-one fetch — batch is better).

Alternative: enrich `PendingClosureSideEffects` with task info directly at the Prisma query level (single JOIN) — avoids N+1.

---

## FE Routing — How to Add the New Sub-Tab

To restructure the IClass sub-tabs:

**Current** (`IClassSettingsBody.tsx`):
```
integracion | catalogo | mapeo | cierre (= IClassClosureFlagBody + IClassResultCodeMappingBody)
```

**Target**:
```
integracion | catalogo | mapeo | procesamiento (= IClassClosureFlagBody + progress table)
             + new sub-tab: mapeo-de-estado (= IClassResultCodeMappingBody)
```

Steps:
1. Extract `IClassResultCodeMappingBody` from the `cierre` fragment into its own sub-tab entry in `SUB_TABS` with id `mapeo-estado` and label `Mapeo de estado`.
2. Rename the existing `cierre` sub-tab to `procesamiento` (id: `procesamiento`, label: `Procesamiento` or `Cierre`).
3. Add `<ClosureProgressTable />` (new component) inside the procesamiento sub-tab body, after the existing cards.

The `Tabs` component (`src/components/molecules/Tabs/Tabs.tsx`) + `mountMode="lazy"` pattern stays unchanged — new sub-tab entry uses the same interface.

**Where backlog #30 (cron interval config) slots in**: the new "Procesamiento" tab body will host a "Intervalo de auto-completado" card (interval config for the TaskAutocompleteScheduler cron) appended after the existing cards, before or after the progress table. Natural slot: after the existing auto-completado toggle card and before the progress table.

---

## Existing Tests to Extend

**BE routes** (`src/__tests__/infrastructure/iclass-closure.routes.test.ts`):
- Add test: `GET /closure/reprocess/pending-list` → 200 with items array

**BE use case** (`src/__tests__/application/GetPendingSideEffectsCount.test.ts`):
- New test file: `GetPendingSideEffectsList.test.ts` — same pattern

**FE component tests**:
- `src/__tests__/scheduling/settings/IClassClosureFlagBody.test.tsx` — add tests for the progress table rendering (new hook `usePendingList`)
- `src/__tests__/scheduling/settings/IClassSettingsBody.test.tsx` — update: now 5 sub-tabs (add `Mapeo de estado`), `cierre` renamed to `Procesamiento`; mock the new `IClassResultCodeMappingBody` → separate sub-tab
- `src/__tests__/hooks/useIClassClosure.test.ts` — add `usePendingList` hook test

---

## Affected Files

### Backend
- `src/domain/ports/ClosedServiceOrderRepository.ts` — possibly add a JOIN method, or reuse existing
- `src/application/use-cases/GetPendingSideEffectsList.ts` — new use case (list with task join)
- `src/infrastructure/http/routes/iclass-closure.routes.ts` — new GET endpoint
- `src/infrastructure/http/app.ts` — wire new use case
- `src/__tests__/application/GetPendingSideEffectsList.test.ts` — new tests
- `src/__tests__/infrastructure/iclass-closure.routes.test.ts` — extend

### Frontend
- `src/pages/scheduling/settings/IClassSettingsBody.tsx` — restructure SUB_TABS (split cierre, rename)
- `src/pages/scheduling/settings/IClassClosureFlagBody.tsx` — remove IClassResultCodeMappingBody (moved to own tab), add progress table
- `src/pages/scheduling/settings/ClosureProgressTable.tsx` — new component (progress table)
- `src/api/iclassClosure.api.ts` — add `pendingList()` call
- `src/hooks/useIClassClosure.ts` — add `usePendingList` hook
- `src/types/iclassClosure.ts` or `scheduling.ts` — new types for pending list items
- `src/__tests__/scheduling/settings/IClassSettingsBody.test.tsx` — update tab count
- `src/__tests__/scheduling/settings/IClassClosureFlagBody.test.tsx` — extend for progress table
- `src/__tests__/hooks/useIClassClosure.test.ts` — extend for usePendingList

---

## Approaches

### Approach A — New `GetPendingSideEffectsList` use case + new endpoint
- Pros: Clean hexagonal, minimal coupling, reuses `listPendingSideEffects` port method already tested
- Cons: Need to join task data (either N+1 or new batch method on SchedulingRepository)
- Effort: Medium

### Approach B — Extend `GetPendingSideEffectsCount` to optionally return the list
- Pros: One fewer file, reuses existing wiring
- Cons: Single Responsibility violation, complicates the test, awkward API shape
- Effort: Low, but wrong

### Approach C — Enrich `listPendingSideEffects` at Prisma level with a JOIN
- Pros: Single DB query, no N+1
- Cons: Changes the domain port interface to leak task fields, or requires a new port method
- Effort: Medium

**Recommendation**: Approach A with a Prisma-level JOIN. Create `GetPendingSideEffectsList` use case that calls a new port method `listPendingSideEffectsWithTask(maxAuditAttempts)` which does a single Prisma query with `include: { scheduledTask: { select: { id, sequenceNumber, title } } }`. This avoids N+1 without leaking Prisma into the domain — the return type just adds an optional `task` sub-object.

---

## Risks

1. **FE type gap**: `closureCommentDone/closureAuditDone/closureHasDeviceInventory` are not in the FE `ScheduledTask` type. The progress table will use the SO side (side-effect tracker) which is accurate, but the `#14 flags` mentioned in the locked decisions refer to `IClassServiceOrder` columns (`commentPosted/inventoryBuilt/auditDone/auditAttempts`), which map 1:1 to those task flags. Clarification needed: which source drives the table — the SO mirror (via `listPendingSideEffects`) or the task flags? Decision: use SO mirror (only pending SOs are shown; task flags are secondary).

2. **IClassSettingsBody test** already asserts exactly 4 sub-tabs (`Integración`, `Catálogo`, `Mapeo de proyectos`, `Cierre de OS`). This test will break and must be updated to assert 5 sub-tabs.

3. **Naming**: the orchestrator specifies the sub-tab be called "Procesamiento/Cierre" — final label TBD. The existing sub-tab id `cierre` can be kept as the URL hash segment to avoid breaking deep-links (label change only).

4. **`#30` slot**: backlog #30 (cron interval config) will touch `IClassClosureFlagBody` (add interval control). It should come after #31 is merged, slotting into the new "Procesamiento" card area after the auto-completado toggle.

---

## Ready for Proposal

Yes. The codebase is fully mapped. No blockers. The next phase can proceed to `sdd-propose` or directly to `sdd-spec` + `sdd-tasks`.
