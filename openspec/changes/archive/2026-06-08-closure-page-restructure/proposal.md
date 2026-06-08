# Proposal: Closure Page Restructure (#31)

## Intent

The IClass `cierre` sub-tab crams two unrelated concerns into one screen: closure-processing controls (flags, reconcile, reprocess) AND the IClass result-code→stage mapping (`IClassResultCodeMappingBody`), glued on at the bottom. Operators also have NO way to see *which* tasks/OS still have pending side-effects — only a raw count badge. This change separates the mapping into its own sub-tab and adds a per-task progress table so operators can see comment/inventory/audit status at a glance.

## Scope

### In Scope
- Split FE: move `IClassResultCodeMappingBody` to a NEW sub-tab "Mapeo de estado"; relabel `cierre`→"Procesamiento" (keep `id:cierre` to preserve deep-links).
- New read-only BE endpoint `GET /closure/reprocess/pending-list` returning pending side-effects joined with task info.
- New use case `GetPendingSideEffectsList` over a new port method `listPendingSideEffectsWithTask()` (single JOIN, no N+1).
- New FE `ClosureProgressTable`: columns comment ✓/✗, inventory ✓/✗, audit ✓/✗ (+ auditAttempts) + task link via sequenceNumber/title.
- Update `IClassSettingsBody.test.tsx` (4→5 sub-tabs) + new BE/FE tests.

### Out of Scope
- Editing side-effect state by hand from the table.
- Per-photo OCR progress.
- Changing `IClassResultCodeMappingBody` internals (relocate only).
- Cron interval control (#30 — slots into "Procesamiento" after #31 ships; leave a clean slot).

## Capabilities

### New Capabilities
- `closure-pending-list`: read-only endpoint + use case `GetPendingSideEffectsList` returning pending side-effects with joined task `{id, sequenceNumber, title}`; FE progress table consuming it.

### Modified Capabilities
- `iclass-closure-loop`: adds the `listPendingSideEffectsWithTask()` port method to `ClosedServiceOrderRepository` (no behavior change to the existing loop; additive read path).

## Approach

Backend (hexagonal): add `listPendingSideEffectsWithTask(maxAuditAttempts)` to the `ClosedServiceOrderRepository` port; Prisma adapter does one query with `include: scheduledTask {id, sequenceNumber, title}`; in-memory adapter mirrors it. `GetPendingSideEffectsList` use case maps to a DTO at the boundary (never raw Prisma). New route wired in `app.ts`, guarded by `auth + requireIClassManage`. Strict TDD: supertest + in-memory.

Frontend: extract mapping into its own `SUB_TABS` entry; relabel `cierre`. Add `usePendingList` hook + `pendingList()` api call; render `ClosureProgressTable` in the Procesamiento body (after existing cards). Page gated by existing `iclass.manage`. Vitest + mocked hooks. The new table + Procesamiento layout use the **impeccable** skill.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `domain/ports/ClosedServiceOrderRepository.ts` | Modified | Add `listPendingSideEffectsWithTask()` |
| `infrastructure/adapters/prisma/*ClosedServiceOrderRepository.ts` | Modified | JOIN query |
| `infrastructure/adapters/in-memory/*` | Modified | Mirror method |
| `application/use-cases/GetPendingSideEffectsList.ts` | New | List + DTO mapping |
| `infrastructure/http/routes/iclass-closure.routes.ts` | Modified | New GET endpoint |
| `infrastructure/http/app.ts` | Modified | Wire use case |
| FE `IClassSettingsBody.tsx` | Modified | Split + relabel sub-tabs |
| FE `IClassClosureFlagBody.tsx` | Modified | Drop mapping, add table |
| FE `ClosureProgressTable.tsx` | New | Progress table |
| FE `useIClassClosure.ts` / `iclassClosure.api.ts` | Modified | `usePendingList` + api |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `IClassSettingsBody.test.tsx` breaks (hardcoded 4 tabs) | High | Update to 5 sub-tabs as part of this change |
| Deep-links break on relabel | Med | Keep `id:cierre`; change label only |
| N+1 on task join | Med | Single Prisma JOIN via new port method |
| Data-source ambiguity (SO mirror vs task flags) | Low | Use SO mirror (`listPendingSideEffects`) — drives the pending list |

## Rollback Plan

FE: revert `SUB_TABS` to the 4-tab fragment and remove `ClosureProgressTable` — purely additive UI. BE: the new endpoint/use case/port method are additive and unused elsewhere; remove the route wiring and files. No migrations, no data changes — clean revert.

## Dependencies

- None blocking. Coordination: #30 (cron interval config) lands AFTER #31 into the new "Procesamiento" tab.

## Success Criteria

- [ ] IClass settings shows 5 sub-tabs; "Mapeo de estado" holds the mapping; "Procesamiento" holds flags/reconcile/reprocess + progress table.
- [ ] `GET /closure/reprocess/pending-list` returns items with joined task info, guarded by `iclass.manage`.
- [ ] `ClosureProgressTable` renders comment/inventory/audit status + auditAttempts + task link.
- [ ] All BE (supertest/in-memory) and FE (Vitest) tests green; `IClassSettingsBody.test.tsx` updated to 5 tabs.
- [ ] Deep-link to `cierre` still resolves.
