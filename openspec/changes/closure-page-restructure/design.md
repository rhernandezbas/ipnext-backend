# Design: Closure Page Restructure (#31)

## Technical Approach

Additive read-path in BE (hexagonal) + a sub-tab split in FE. BE adds one port method `listPendingSideEffectsWithTask()` (single Prisma `include`, no N+1), a thin use case `GetPendingSideEffectsList` mapping to a DTO at the boundary, and a `GET /closure/reprocess/pending-list` route mirroring the existing `pending-count` wiring. FE splits the `cierre` fragment: mapping moves to its own sub-tab, `cierre` is relabeled "Procesamiento", and a new `ClosureProgressTable` (driven by `usePendingList`) mounts as a sibling of `IClassClosureFlagBody`. Implements specs `closure-pending-list` (REQ-LIST-1..4) and `iclass-closure-loop` (port delta). No schema change, no migration.

## Architecture Decisions

| Decision | Choice | Rejected | Rationale |
|----------|--------|----------|-----------|
| Task join | New port method `listPendingSideEffectsWithTask()` with single Prisma `include: { scheduledTask: { select } }` | N+1 per-task fetch; batch `findManyByIds` on SchedulingRepository | One query, no N+1; SO mirror already owns the FK relation `scheduledTask`. Existing `listPendingSideEffects` stays untouched (additive). |
| Use case shape | New `GetPendingSideEffectsList` returning `{ items, total }`, `total === items.length` | Extend `GetPendingSideEffectsCount` to optionally return list | SRP; the count use case stays a thin badge feeder. Same `MAX_AUDIT_ATTEMPTS = 3` constant. |
| Table mount point | `ClosureProgressTable` as sibling of `IClassClosureFlagBody` in `IClassSettingsBody` (`<><IClassClosureFlagBody/><ClosureProgressTable/></>`) | Mount inside `IClassClosureFlagBody` | Keeps the flag body focused; table owns its own hook/state; matches orchestrator decision #3. |
| Sub-tab id | Keep `id: 'cierre'`, change label only to "Procesamiento" | New `id: 'procesamiento'` | Preserves any deep-link to `cierre` (spec REQ-LIST-4). |
| Polling | `usePendingList` mirrors `usePendingCount`: `refetchInterval` stops at empty (`total === 0 → false`, else 5000ms) | Always-on polling | Consistency with existing hook; avoids idle network churn. |

## Data Flow

    ClosureProgressTable ──usePendingList──→ GET /closure/reprocess/pending-list
            │                                         │ auth + requireIClassManage
            │                                         ▼
            │                              GetPendingSideEffectsList.execute()
            │                                         │
            │                    listPendingSideEffectsWithTask(MAX_AUDIT_ATTEMPTS)
            │                                         │
            ▼                              IClassServiceOrder.findMany({ include: scheduledTask })
       rows: comment ✓/✗, inventory ✓/✗, audit ✓/✗ (+auditAttempts), task link #seq · title

## File Changes

| File | Action | Description |
|------|--------|-------------|
| BE `domain/ports/ClosedServiceOrderRepository.ts` | Modify | Add `PendingClosureSideEffectsWithTask` type + `listPendingSideEffectsWithTask(max)` to interface |
| BE `infrastructure/adapters/prisma/PrismaClosedServiceOrderRepository.ts` | Modify | New method: same `where` as `listPendingSideEffects` + `include: { scheduledTask: { select: { id, sequenceNumber, title } } }`; map to `task` or `null` |
| BE `infrastructure/adapters/in-memory/InMemoryClosedServiceOrderRepository.ts` | Modify | New method; resolve task from an injectable `tasks` Map (id → {id, sequenceNumber, title}) seeded by tests |
| BE `application/use-cases/GetPendingSideEffectsList.ts` | Create | Calls port, maps to `{ items, total }` DTO |
| BE `infrastructure/http/routes/iclass-closure.routes.ts` | Modify | Add `getPendingList` param + `GET /closure/reprocess/pending-list` (auth + requireIClassManage), mirror pending-count |
| BE `infrastructure/http/app.ts` | Modify | Construct `GetPendingSideEffectsList` (same `closedServiceOrderRepo`), pass into router |
| FE `pages/scheduling/settings/IClassSettingsBody.tsx` | Modify | SUB_TABS: relabel `cierre`→"Procesamiento" body `<><IClassClosureFlagBody/><ClosureProgressTable/></>`; add `{id:'mapeo-estado', label:'Mapeo de estado', content:<IClassResultCodeMappingBody/>}` |
| FE `pages/scheduling/settings/ClosureProgressTable.tsx` | Create | Table; impeccable skill drives layout + empty state |
| FE `api/iclassClosure.api.ts` | Modify | Add `ClosurePendingItem`/`ClosurePendingList` types + `pendingList()` |
| FE `hooks/useIClassClosure.ts` | Modify | Add `usePendingList()` (stop-at-empty polling) |
| BE `__tests__/application/GetPendingSideEffectsList.test.ts` | Create | Maps port → DTO, task null case, total |
| BE `__tests__/infrastructure/iclass-closure.routes.test.ts` | Modify | 200 list, 401, 403 |
| FE `__tests__/scheduling/settings/IClassSettingsBody.test.tsx` | Modify | 4→5 tabs; mapping in its own tab |
| FE `__tests__/.../IClassClosureFlagBody.test.tsx` + `__tests__/hooks/useIClassClosure.test.ts` | Modify | Table render + hook |

## Interfaces / Contracts

```ts
// domain/ports/ClosedServiceOrderRepository.ts
export interface PendingClosureSideEffectsWithTask extends PendingClosureSideEffects {
  task: { id: string; sequenceNumber: number; title: string } | null;
}
listPendingSideEffectsWithTask(maxAuditAttempts: number): Promise<PendingClosureSideEffectsWithTask[]>;
```

```ts
// GetPendingSideEffectsList result (DTO — never raw Prisma)
interface PendingSideEffectItem extends PendingClosureSideEffectsWithTask {}
interface GetPendingSideEffectsListResult { items: PendingSideEffectItem[]; total: number }
```

Prisma map: `task: r.scheduledTask ? { id, sequenceNumber, title } : null` (relation is nullable via `scheduledTaskId @unique`).

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Unit (BE) | `GetPendingSideEffectsList` maps port→DTO; task-null; `total===items.length` | InMemory adapter (seed tasks Map) — strict TDD red→green |
| Integration (BE) | Route 200 with items, 401 no auth, 403 no `iclass.manage` | supertest + in-memory repo |
| Unit (FE) | 5 sub-tabs + mapping isolation; table rows/empty/no-task-link; `usePendingList` stop-at-empty | Vitest, mocked hook/components |

## Migration / Rollout

No migration required. Purely additive endpoint + UI split; rollback = remove the route/use-case/port method and revert SUB_TABS to the 4-tab fragment.

## #30 Slot

In the Procesamiento body, reserve the slot **after the auto-completado toggle card** (`IClassClosureFlagBody` line ~217) and **before `ClosureProgressTable`** for #30's "Intervalo de auto-completado" control. No code now — note it in tasks so #30 mounts there without re-layout.

## Open Questions

- [ ] None blocking. (Table uses the SO-mirror side-effect tracker, not the `ScheduledTask.closure*` flags — settled in exploration.)
