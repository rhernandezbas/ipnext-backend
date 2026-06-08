# Proposal: Network-Node Task ("Tarea de RED")

## Intent

Operators need to create scheduling tasks bound to a network node (NetworkSite) instead of a customer + contract — e.g. tower maintenance, POP work. Today `CreateTask` hard-requires customer+contract (`CreateTask.ts:23-34`), the zod schema requires both (`scheduling.dto.ts:82-89`), and IClass send validates customer fields (`SendTaskToIClass.ts:104-114`). The DB and entity already allow null customer/contract, and the IClass adapter is already node-aware (`IClassClient.ts:301` `nodeCode ?? city`). This unblocks a node-only task that keeps the full flow (project, workflow, stages, IClass dispatch, same kanban).

## Scope

### In Scope
- BE: `ScheduledTask` gains `networkSiteId` (FK→NetworkSite) + `kind` discriminator ('customer'|'network'); additive migration via `prisma migrate diff`.
- BE: `iclassNodeCode` field added to `NetworkSite` (explicit IClass mapping; no fuzzy matching).
- BE: `CreateTask` + `CreateTaskSchema` gate customer/contract validation by `kind`; network mode validates `networkSiteId` exists.
- BE: `SendTaskToIClass` substitutes node-derived values + passes explicit `nodeCode` for network tasks.
- FE: RED side toggle inside existing `CreateTaskModal` swapping CustomerPicker+ContractSelect for a NodeSelector (`useNetworkSites`).
- FE: RED badge on network tasks in the kanban; `iclassNodeCode` field on the NetworkSite form.

### Out of Scope
- Editing node↔IClass mapping UI beyond the single `iclassNodeCode` field.
- Bulk network-task creation.
- Any change to the customer-task path behavior (must not regress).

## Capabilities

### New Capabilities
- None (extends existing capabilities).

### Modified Capabilities
- `scheduling`: tasks gain a `kind` discriminator and optional `networkSiteId`; create-time validation branches by mode.
- `iclass-integration`: network tasks substitute customer fields with node-derived values and send an explicit `nodeCode`.

## Approach

Option A from exploration: relax `ScheduledTask` with a `kind` discriminator + `networkSiteId` FK (model/mapper/read paths already nullable-ready). Inject a `NetworkSiteRepository` port into `CreateTask`; gate validation by `kind`. For IClass dispatch, when `kind='network'` substitute customer fields from the node and pass `iclassNodeCode` as the `nodeCode` override (existing line-301 mechanism). FE reuses the modal via a mode toggle. Permission: reuse `scheduling.write` unless design finds a reason to split.

**Substitution defaults (design MUST verify):** customerName=site name, address=site address, city=site city, customerCode=`iclassNodeCode` (or fixed "NETWORK"), phone=empty/placeholder. Verify IClass accepts empty phone; else use a placeholder.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modified | `networkSiteId`+`kind` on ScheduledTask; `iclassNodeCode` on NetworkSite |
| `src/domain/entities/scheduling.ts` | Modified | Add `kind`, `networkSiteId`, `networkSiteName` |
| `src/application/use-cases/CreateTask.ts` | Modified | Branch validation by kind; inject NetworkSiteRepository |
| `src/application/dto/scheduling.dto.ts` | Modified | Conditional/discriminated CreateTaskSchema |
| `src/application/use-cases/SendTaskToIClass.ts` + `dispatchTaskToIClass.ts` | Modified | Node substitution + explicit nodeCode |
| `src/domain/entities/networkSite.ts` + repo/use cases | Modified | `iclassNodeCode` field |
| FE `CreateTaskModal.tsx`, NetworkSite form, kanban card | Modified | Toggle, NodeSelector, badge |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Customer-mode invariants regress | Med | Discriminated schema + tests for both kinds; keep customer branch identical |
| IClass rejects empty phone for node SO | Med | Design verifies; placeholder fallback |
| Two repos drift (BE/FE contract) | Med | DTO is the contract; ship BE field-tolerant first |
| `kind` default ambiguity on legacy rows | Low | Default `kind='customer'` in migration backfill |

## Rollback Plan

Migration is additive (`networkSiteId`, `kind`, `iclassNodeCode` all nullable/defaulted) — revert the FE toggle and BE validation branch; existing rows default to `kind='customer'`. No data backfill to undo. Drop columns only if fully reverting.

## Dependencies

- NetworkSite CRUD (exists). IClass `nodeCode` override (exists, `IClassClient.ts:301`).
- Coordinated FE repo: `C:\Users\ronald\projects\ipnext\ipnext-frontend`.

## Success Criteria

- [ ] Operator toggles RED mode, picks a node, creates a task with `customerId=null, contractId=null, networkSiteId` set.
- [ ] Network task flows through stages and dispatches to IClass with node-derived customer fields + explicit `nodeCode`.
- [ ] Customer-task creation and dispatch behavior unchanged (regression tests pass).
- [ ] Network tasks show a RED badge in the same kanban.
- [ ] Migration is additive; legacy tasks default to `kind='customer'`.
