# Proposal — gr-clients-full-universe

## Intent

Close the gap between what the local mirror reports and what Gestión Real (GR) actually holds, and make the **estado** model faithful to GR's reality. Two symptoms motivate this:

1. **Client-count mismatch.** The local DB reports **5122** clients with `grClienteId`; GR reports **5119**. We need to *diagnose first* — produce a read-only set-diff of which `grClienteId`s exist locally but are absent from GR's full universe — before touching any data.
2. **Lossy estado mapping.** GR's *Baja* (codigo 6) and *Inactivo* (codigo 3) both collapse into the local `inactive` status today, so a churned-out client (Baja) is indistinguishable from a merely inactive one. Operations cannot tell them apart.

This change delivers a safe, diagnosis-first reconcile endpoint, syncs the **full estado universe** (not just Activo+Deudor), and adds a first-class **`baja`** status. It deliberately does **not** delete anything.

## Problem

1. **Append-only sync drift.** `SyncGestionRealClients` only ever calls `mirror.upsertClient` (`SyncGestionRealClients.ts:84`); `PrismaClientMirrorRepository.upsertClient` only inserts/updates (`PrismaClientMirrorRepository.ts:33-64`). Nothing ever reconciles or removes a row that vanished from GR. The mirror is **append-only**, so once a client leaves GR's result set the local row lingers forever → permanent positive drift.
2. **Apples vs. oranges count.** Local `clientCount()` counts **all** rows with `grClienteId` (`PrismaMirrorCountsRepository.ts:5-7`). GR's "5119" is the count under the **filtered** sync scope `GR_SYNC_ESTADOS=1,2` (Activo+Deudor) defined in `config.ts:43`. The two numbers are not measuring the same set, so part of the "5122 vs 5119" gap is a definitional artifact and part may be real orphan drift. We cannot tell which without a true set-diff.
3. **No way to see orphans.** There is no endpoint or report that enumerates `grClienteId`s present locally but absent from GR's full universe. Diagnosis today is guesswork.
4. **Estado model loses information.** `mapStatus` (`PrismaClientMirrorRepository.ts:8-16`) maps `1→active`, `2→late`, `4→blocked` (= *Incobrable*), and **both** `3` (Inactivo) and `6` (Baja) → `inactive`. The enum `ClientStatus` (`schema.prisma:214-219`) has no `baja` value. So *Baja* is invisible — it masquerades as *inactive*. Note: `blocked` already means **Incobrable**, NOT Baja; conflating Baja into inactive (rather than blocked) is the current — still lossy — behavior.
5. **Sync scope is narrow.** `GR_SYNC_ESTADOS` defaults to `1,2`, so estados 3/4/6 are never pulled into the mirror at all. Even after adding a `baja` status, no client would ever *receive* it until the sync scope is widened to include codigo 6 (and 3, 4).

## Scope IN

- **Read-only reconcile endpoint (diagnosis first).** A new authenticated endpoint under the existing GR-sync admin surface (`POST /api/admin/gr-sync/reconcile-report`, alongside the existing `reset-clients-cursor`) that:
  - fetches the **full GR universe** (all estados, via `fetchClients` with no estado filter, paginated like the sync does),
  - reads the set of local `grClienteId`s,
  - returns the **set-diff**: `localOnly` (orphan candidates present locally, absent in GR), plus summary counts (`localTotal`, `grTotal`, `localOnlyCount`, and optionally `grOnlyCount`).
  - **Touches NO data** — no insert, no update, no delete. Pure diagnosis.
- **Full-universe sync scope.** Change the default `GR_SYNC_ESTADOS` to bring the full universe `1,2,3,4,6` so the mirror reflects GR across all estados (the sync mechanism already supports per-estado segments — `SyncGestionRealClients.ts:54,70`).
- **New `baja` status.** Add `baja` to the `ClientStatus` enum (`schema.prisma`), and remap in `mapStatus`: `6→baja`, `3→inactive` (kept), `4→blocked` (kept = Incobrable). Forward-only Prisma migration using `ALTER TYPE ... ADD VALUE`.
- **DTO contract preserved.** The `status` field in any client DTO stays a **string** so the frontend contract does not break. The estado-code↔status-name translation stays inside the repository/mapper (`mapStatus`), never leaked to use-cases or routes. Adding `baja` is additive at the wire level (a new possible value), not a shape change.

## Scope OUT

- **Any deletion / reconciliation write.** The reconcile endpoint is read-only. Actually deleting or de-mirroring orphan rows is **explicitly deferred** — see Risks (FK cascades make it dangerous) and Open Questions.
- **Feature-flag table, cron-config page, RBAC for sync settings.** These belong to a **separate follow-up change `gr-clients-sync-config-page`** (configurable estados/cadence via UI instead of env, with permissions). Not designed here.
- **Reverting the GR-as-source-of-truth posture.** No new Splynx calls; Postgres remains source of truth.
- **Balance/debt amount work.** Owned by the sibling `gr-client-balance-sync` change; untouched here.
- **Frontend implementation.** Showing the new "Bajas" label distinct from "Incobrable" is a coordinated change in `ipnext-frontend` (see Affected Areas → Frontend) with its own commits per `WORKFLOW-MULTI-REPO.md`.

## Approach (high level)

1. **Reconcile (diagnosis) — read-only use case + endpoint.**
   - New use case `ReconcileGrClients` (application layer) that depends on the existing `GestionRealPort` (full-universe fetch) and a read-only mirror-ids port. It enumerates GR's full universe (paginated, no estado filter), loads local `grClienteId`s, and computes the set-diff. Returns a DTO of counts + the `localOnly` id list. No write ports injected → structurally incapable of mutating data.
   - Expose via `gr-sync.routes.ts` as `POST /api/admin/gr-sync/reconcile-report` behind `authMiddleware`, wired in `app.ts` next to the existing GR-sync router (one extra constructor arg — minimal app.ts footprint).
2. **Full-universe sync scope.** Flip the `GR_SYNC_ESTADOS` default from `1,2` to `1,2,3,4,6` in `config.ts`. No code-path change — the sync already loops per estado segment. Document that operators can still override via env.
3. **`baja` status.**
   - Migration: `ALTER TYPE "ClientStatus" ADD VALUE 'baja';` — **hand-written**, because Postgres does not allow `ADD VALUE` inside a transaction block in older versions; the migration must run outside the implicit transaction (Prisma caveat to handle in the migration file).
   - Update `mapStatus` (`PrismaClientMirrorRepository.ts:8-16`): `6→baja`, leave `3→inactive`, `4→blocked`. After the migration + scope widening, the next sync naturally restamps codigo-6 clients to `baja`.
   - Mirror DTO/mapper keeps `status` as a string; add `'baja'` to any TypeScript string-union that mirrors the enum.
4. **Diagnose → decide later.** With the reconcile report in hand, a future change can choose a safe reconciliation strategy (soft-flag vs. delete) — out of scope here.

## Risks

1. **Future deletion would cascade.** FKs to `Client` are asymmetric: `ScheduledTask.customerId` is `onDelete: SetNull` (safe), but `Service`, `ClientLog`, and `Invoice` are `onDelete: Cascade`. Deleting an orphan client would silently destroy its **invoices and services**. The reconcile endpoint is read-only **specifically to avoid this**, but the proposal flags that *any* future deletion strategy is high-risk and must be designed deliberately (soft-delete/flag preferred over hard delete). **Deferred.**
2. **`ADD VALUE` transaction caveat.** Postgres `ALTER TYPE ... ADD VALUE` cannot run inside a transaction on older server versions, and the new value isn't usable in the same transaction. The migration must be authored to run outside Prisma's wrapping transaction (or split). If mishandled, the migration fails on apply. Mitigation: hand-written migration with the documented caveat; verify against the target Postgres version in Phase 0.
3. **Count inflation after widening scope.** Once `GR_SYNC_ESTADOS=1,2,3,4,6`, the mirror will pull estados 3/4/6 it never pulled before — `clientCount()` (all-estados) will **rise**, and the "5122 vs 5119" framing changes because GR's comparison number must now also be the full-universe total, not the 1,2-filtered total. Mitigation: the reconcile report computes `grTotal` over the **same** full universe, making the comparison apples-to-apples; document that the headline count will shift after this change ships.
4. **Restamp side effects.** Re-stamping codigo-6 clients from `inactive` to `baja` changes a status many UI filters/queries key on. Any backend query that special-cases `inactive` must be audited so it doesn't accidentally include/exclude the newly-distinct `baja` set. Mitigation: grep for `'inactive'` usage during apply; coordinate the FE filter update.
5. **Full-universe fetch cost.** The reconcile endpoint pages the entire GR catalog (~5k+ rows, 100/page → ~50+ authenticated POSTs) on each call. It's an on-demand admin diagnostic, not a hot path. Mitigation: sequential paging reusing the sync's pattern; keep it admin-only; do not put it on a timer (that's the config-page follow-up's concern).
6. **DTO contract drift.** If `status` were ever serialized as an enum object instead of a string, adding `baja` could break the FE. Mitigation: assert `status` stays a string in tests; the name↔code translation never leaves the mapper.

## Rollback Plan

- **Reconcile endpoint**: pure read-only addition — removing the route + use case is a clean revert with zero data impact.
- **`GR_SYNC_ESTADOS` default**: revert to `1,2` in `config.ts`; operators can also override via env without a deploy. Already-synced estado-3/4/6 rows remain but are harmless (they were valid GR clients).
- **`baja` enum value**: Postgres cannot **drop** an enum value cleanly, so the migration is effectively forward-only. Rolling back means restamping `baja` rows back to `inactive` (data fix), leaving the unused enum value in place (harmless). This forward-only nature must be called out in `design.md`.
- No destructive DDL on `Client` rows; no client data deleted at any point.

## Affected Areas

### Backend
- `src/application/use-cases/ReconcileGrClients.ts` (new — read-only set-diff use case).
- `src/application/dto/` — new reconcile-report DTO (counts + `localOnly` ids).
- `src/domain/ports/` — a read-only port to list local `grClienteId`s (extend `MirrorCountsRepository` or a new `ClientMirrorReadRepository`; decide in `design.md`). `GestionRealPort.fetchClients` is reused as-is for the full-universe scan.
- `src/infrastructure/adapters/prisma/PrismaMirrorCountsRepository.ts` (or new read repo) + matching `in-memory/` adapter — implement the local-ids read.
- `src/infrastructure/http/routes/gr-sync.routes.ts` — add `POST /reconcile-report`.
- `src/infrastructure/http/app.ts` — wire `ReconcileGrClients` into `createGrSyncRouter` (one extra arg; minimal footprint on the God Object).
- `src/infrastructure/config.ts:43` — change `GR_SYNC_ESTADOS` default to `1,2,3,4,6`.
- `prisma/schema.prisma:214-219` — add `baja` to `enum ClientStatus`.
- `prisma/migrations/<ts>_client_status_baja/migration.sql` (new — hand-written `ALTER TYPE ... ADD VALUE`, transaction caveat handled).
- `src/infrastructure/adapters/prisma/PrismaClientMirrorRepository.ts:8-16` — `mapStatus`: `6→baja`; update the local `ClientStatus` string-union (line 5) to include `'baja'`.
- Tests under `src/__tests__/` (application + infrastructure) per the in-memory port convention — reconcile set-diff cases, `mapStatus` `6→baja`, DTO `status` stays a string.

### Frontend (sibling repo `ipnext-frontend` — coordination only, NOT implemented here)
- Render a distinct **"Baja"** label/filter separate from **"Incobrable"** (`blocked`) and **"Inactivo"** (`inactive`).
- Extend the client `status` union/labels to include `baja`.
- Coordinated per `WORKFLOW-MULTI-REPO.md` with its own commits.

## Open Questions

1. **Reconcile direction & shape.** Do we also want `grOnly` (in GR, absent locally — a *missed-insert* signal) in the same report, or only `localOnly` orphans? Cheap to add since we already hold both sets.
2. **Estado 5?** GR estado codes seen so far are 1,2,3,4,6 — is there a codigo 5, and if so how should it map? (Default falls through to `inactive` today.)
3. **`baja` vs. `blocked` semantics downstream.** Are there backend queries/reports that currently treat `inactive` as "not-a-real-client" and would need to also include `baja`? (Audit during apply.)
4. **Comparison baseline going forward.** After widening scope, do we report the headline client count as the full-universe total, or keep a separate "active+debtor" KPI for continuity with the old "5119" number?

## Next

`sdd-spec` — write delta specs (reconcile endpoint contract, full-universe sync scope, `baja` status + DTO invariants), then `sdd-design` for the migration/enum/port decisions.
