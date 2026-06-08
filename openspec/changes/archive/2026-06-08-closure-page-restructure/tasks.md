# Tasks: Closure Page Restructure (#31)

<!-- Spec scenarios mapped: 15 total (iclass-closure-loop: 3, closure-pending-list: 12) -->
<!-- Strict TDD: RED → GREEN per task pair -->

---

## Batch A — Backend

### Phase A1: Port & In-Memory Adapter

- [x] A1.1 **RED** — Write failing test in `GetPendingSideEffectsList.test.ts`: seeded InMemory returns 2 items, one with task, one without; verifies DTO shape `{items, total}`. *(iclass-closure-loop SC1, SC2; REQ-LIST-2 SC1)*
- [x] A1.2 Add `PendingClosureSideEffectsWithTask` type + `listPendingSideEffectsWithTask(max)` signature to `domain/ports/ClosedServiceOrderRepository.ts`. *(iclass-closure-loop REQ)*
- [x] A1.3 Implement `listPendingSideEffectsWithTask` in `InMemoryClosedServiceOrderRepository.ts` with injectable `tasks: Map<string, {id,sequenceNumber,title}>` — resolve or null. *(iclass-closure-loop SC1, SC2)*
- [x] A1.4 **RED** — Assert existing `listPendingSideEffects` call still returns original shape unmodified. *(iclass-closure-loop SC3)*
- [x] A1.5 **GREEN** — Verify A1.4 passes with no changes to existing method.

### Phase A2: Use Case

- [x] A2.1 Create `application/use-cases/GetPendingSideEffectsList.ts`: calls port `listPendingSideEffectsWithTask(MAX_AUDIT_ATTEMPTS)`, maps to `{items, total}` DTO — never leaks Prisma entities. *(REQ-LIST-2)*
- [x] A2.2 **GREEN** — All tests from A1.1 pass with the real use case calling InMemory adapter.
- [x] A2.3 **RED** — Add test: `total === items.length` invariant and `task: null` mapped correctly. *(REQ-LIST-2 SC1)*

### Phase A3: Prisma Adapter

- [x] A3.1 Implement `listPendingSideEffectsWithTask` in `PrismaClosedServiceOrderRepository.ts`: same `where` as `listPendingSideEffects` + `include: { scheduledTask: { select: {id, sequenceNumber, title} } }`; map `task` or `null`. *(REQ-LIST-1 SC1, SC2)*

### Phase A4: Route + App Wiring

- [x] A4.1 **RED** — Add supertest cases to `iclass-closure.routes.test.ts`: `200` with 3 items (SC1), `200 {items:[], total:0}` (SC3), null-task JOIN (SC2), `401` no token (SC4), `403` no `iclass.manage` (SC5). *(REQ-LIST-1 SC1–SC5)*
- [x] A4.2 Add `getPendingList` param to `iclass-closure.routes.ts`; register `GET /closure/reprocess/pending-list` guarded by `auth + requireIClassManage`.
- [x] A4.3 Construct `GetPendingSideEffectsList` in `app.ts` (same `closedServiceOrderRepo`), pass into router.
- [x] A4.4 **GREEN** — All A4.1 supertest cases pass.

### Phase A5: Batch A Verify

- [x] A5.1 Run `npx jest --runInBand` — all BE tests green.
- [x] A5.2 Run `npx tsc --noEmit` — zero type errors.

---

## Batch B — Frontend

### Phase B1: API + Hook

- [x] B1.1 Add `ClosurePendingItem` / `ClosurePendingList` types + `pendingList()` fn to `api/iclassClosure.api.ts`. *(REQ-LIST-1 shape)*
- [x] B1.2 **RED** — Write Vitest test for `usePendingList`: polling stops when `total === 0`; resumes when items exist. *(design polling decision)*
- [x] B1.3 Add `usePendingList()` to `hooks/useIClassClosure.ts` mirroring `usePendingCount` refetchInterval logic. *(design)*
- [x] B1.4 **GREEN** — B1.2 tests pass.

### Phase B2: ClosureProgressTable Component

- [x] B2.1 **RED** — Write Vitest tests for `ClosureProgressTable`: rows with task link (REQ-LIST-3 SC1), null-task dash (REQ-LIST-3 SC2), empty state (REQ-LIST-3 SC3).
- [x] B2.2 **IMPECCABLE REMINDER** — Before implementing the component layout, invoke `/impeccable` for the table design: columns (comment ✓/✗, inventory ✓/✗, audit ✓/✗, auditAttempts, task link), empty state, and null-task placeholder.
- [x] B2.3 Create `pages/scheduling/settings/ClosureProgressTable.tsx` applying the impeccable design; consume `usePendingList`.
- [x] B2.4 **GREEN** — All B2.1 tests pass.

### Phase B3: IClassSettingsBody SUB_TABS Restructure

- [x] B3.1 **RED** — Update `IClassSettingsBody.test.tsx`: assert 5 sub-tabs with labels (Integración, Catálogo, Mapeo de proyectos, Mapeo de estado, Procesamiento); `IClassResultCodeMappingBody` only in Mapeo de estado; `IClassClosureFlagBody` + `ClosureProgressTable` only in Procesamiento. *(REQ-LIST-4 SC1–SC3)*
- [x] B3.2 Modify `IClassSettingsBody.tsx` SUB_TABS: keep `id:'cierre'`, relabel → "Procesamiento", body `<><IClassClosureFlagBody/>{/* TODO #30: interval control slot */}<ClosureProgressTable/></>`. Add `{id:'mapeo-estado', label:'Mapeo de estado', content:<IClassResultCodeMappingBody/>}`. *(REQ-LIST-4)*
- [x] B3.3 **GREEN** — All B3.1 tests pass.

### Phase B4: Batch B Verify

- [x] B4.1 Run `npx vitest run` — all FE tests green.
- [x] B4.2 Run `npm run typecheck` — zero type errors.
- [x] B4.3 Confirm deep-link to `cierre` id still resolves (no routing regression).
