# Design — gr-clients-full-universe

## Technical Approach

This change has three independent seams, all additive and reusing existing patterns — no new architecture:

1. **A read-only diagnosis use case (`ReconcileGrClients`)** that pages GR's *full universe* (no estado filter) and set-diffs it against the local mirror's `grClienteId`s. It is injected with **read ports only**, so it is structurally incapable of mutation.
2. **A scope widening** (`GR_SYNC_ESTADOS` default `1,2` → `1,2,3,4,6`) — a one-line config change, no code-path change (the sync already loops per-estado).
3. **A first-class `baja` status** — enum value via a forward-only `ALTER TYPE ... ADD VALUE`, `mapStatus` `6→baja`, and a string-union widening.

The existing GR seams we extend along:
- `GestionRealPort.fetchClients(params)` already accepts an **optional** `estado` — omitting it yields a full unfiltered scan. **No port change is required** (reality-checked below).
- The mirror cleanly separates write (`ClientMirrorRepository`) from counts (`MirrorCountsRepository`); the estado-code↔status translation already lives inside `PrismaClientMirrorRepository.mapStatus`, never leaking to the app layer.
- `gr-sync.routes.ts` already hosts one admin endpoint (`reset-clients-cursor`) behind `authMiddleware`, wired in `app.ts` with a single constructor arg — we follow that exact shape.

## Architecture Decisions

### AD-1 — Read-only local-ids port: a NEW `ClientMirrorReadRepository`, NOT an extension of `MirrorCountsRepository`

**Choice**: Create a new domain port `src/domain/ports/ClientMirrorReadRepository.ts`:

```ts
export interface ClientMirrorReadRepository {
  /** All grClienteId values present in the local mirror (Client.grClienteId NOT null). */
  listGrClienteIds(): Promise<string[]>;
}
```

with a Prisma adapter `PrismaClientMirrorReadRepository` and an in-memory `InMemoryClientMirrorReadRepository`.

**Alternatives**:
- **Extend `MirrorCountsRepository` with `listGrClienteIds()`.** Rejected on **Interface Segregation**. `MirrorCountsRepository` is consumed by `GetGestionRealSyncStatus` (`app.ts:829`) purely for `clientCount()`/`contractCount()` aggregates — a *cardinality* concern. `listGrClienteIds()` is an *enumeration* concern (it returns the actual id set, potentially 5k+ strings). Folding it in would force the status-endpoint's adapter to grow a method it never calls, and conflate "how many" with "which ones". Two roles, two ports.
- **Reuse `ClientMirrorRepository` (the write port).** Rejected outright: that port is the *write* side (`upsertClient`, `updateClientBalance`). Injecting it into a read-only use case would defeat the entire safety invariant (REQ-REC-READONLY-1) — the use case could call `upsertClient`. The whole point is that `ReconcileGrClients` receives **no write port**.

**Rationale**: cohesion + ISP. The use case depends on exactly two read ports — `GestionRealPort` (already read-capable for our purposes) and `ClientMirrorReadRepository` — and nothing that can write. Safety is enforced by *construction*, not by discipline. This is the cleanest answer to the spec's "structurally incapable of mutation" requirement.

> Naming follows the project convention: `Prisma{Entity}Repository` / `InMemory{Entity}Repository`.

### AD-2 — Full-universe fetch: omit `estado`, reuse the sync's paging loop verbatim

**Choice**: `ReconcileGrClients` pages GR with **no estado filter** by simply never setting `params.estado`. It runs a single paginated scan (contrast with `SyncGestionRealClients`, which wraps the same loop in a per-estado `for` over `this.estados`).

Exact params per page (no date filter, no estado):
```ts
const params: FetchClientsParams = { cantidad: pageSize, offset };
// NO params.estado, NO params.fechaTipo/fechaDesde/fechaHasta
const { total, clients } = await this.gr.fetchClients(params);
// accumulate clients.map(c => c.grClienteId); offset += pageSize;
// break when clients.length === 0 || offset >= total
```

This is the identical termination condition as `SyncGestionRealClients.ts:90` (`if (clients.length === 0 || offset >= total) break;`). `pageSize` defaults to `100` (GR's cap, matching `DEFAULT_PAGE_SIZE`), overridable via an options bag for tests.

**Rationale**: REQ-REC-DIFF-1 / REQ-REC-PAGINATION-1 demand the *complete* universe regardless of the sync's `GR_SYNC_ESTADOS`. Omitting `estado` is exactly what `SyncGestionRealClients` does for its `undefined` segment (`this.estados = [undefined]` when no filter) — the real `GestionRealClient` and the `InMemoryGestionRealPort` both already treat a missing `estado` as "all" (`InMemoryGestionRealPort.ts:31` only filters `if (params.estado)`). The reconcile must NOT read `config.gestionReal.estados` — it always scans the full universe.

### AD-3 — `ReconcileReportDTO` shape and location

**Choice**: A new DTO at `src/application/dto/ReconcileReportDTO.ts`:

```ts
export interface ReconcileReportDTO {
  localTotal: number;
  grTotal: number;
  localOnlyCount: number;
  grOnlyCount: number;
  localOnly: string[]; // grClienteId present locally, absent in GR (orphan candidates)
  grOnly: string[];    // grClienteId present in GR, absent locally (missed inserts)
}
```

The use case `execute()` returns this DTO directly — never a Prisma entity, never the raw GR JSON (REQ-REC-PORT-1). Invariants the use case guarantees: `localOnlyCount === localOnly.length`, `grOnlyCount === grOnly.length`, `localTotal === <distinct local ids>`, `grTotal === <distinct GR ids>`.

**Set-diff computation** (pure, in the use case):
```ts
const grSet = new Set(grIds);
const localSet = new Set(localIds);
const localOnly = localIds.filter(id => !grSet.has(id));
const grOnly = grIds.filter(id => !localSet.has(id));
```
`localTotal = localSet.size`, `grTotal = grSet.size` (use the Set sizes to be robust to any GR duplicate across pages).

### AD-4 — Endpoint wiring: one extra constructor arg, mirror the `reset-clients-cursor` shape

**Choice**: Add `POST /reconcile-report` to `createGrSyncRouter`, which gains **one** extra parameter:

```ts
export function createGrSyncRouter(
  authProvider: AuthProvider,
  resetGrClientsCursor: ResetGrClientsCursor,
  reconcileGrClients: ReconcileGrClients, // NEW
): Router {
  // ... existing reset-clients-cursor route ...
  router.post('/reconcile-report', auth, async (_req, res, next): Promise<void> => {
    try {
      const report = await reconcileGrClients.execute();
      res.json(report); // ReconcileReportDTO — already wire-shaped
    } catch (err) { next(err); }
  });
  return router;
}
```

Both routes share the same `auth = createAuthMiddleware(authProvider)` (REQ-REC-AUTH-1: 401 without a valid token).

**`app.ts` footprint** (the God-Object constraint): the existing wiring at `app.ts:832-835` becomes one new collaborator constructed inline. `ReconcileGrClients` needs a `GestionRealPort` (the `grClient` is constructed inside the `if (config.gestionReal.enabled...)` block at `app.ts:453`) and a `ClientMirrorReadRepository`. Two realities to handle:

- The GR client is only built when GR is enabled/configured. To avoid leaking that scope, construct `ReconcileGrClients` **inside** the same guarded block (where `grClient` is in scope) into a `let reconcileGrClients: ReconcileGrClients | undefined`, mirroring the existing `balanceRefresh` pattern (`app.ts:451-463`). When GR is disabled, the route can be wired with an `undefined`-guarding stub or the router simply registered to 503/404 on that path. **Decision**: declare `let reconcileGrClients` next to `balanceRefresh`; assign inside the GR-enabled block; pass it to `createGrSyncRouter`. The route handler 503s if the collaborator is absent (GR not configured) — consistent with the endpoint being a GR-dependent diagnostic.
- Net new lines in `app.ts`: ~2 (one `let`, one assignment) plus the existing call gains one arg. No factory, no new module imports beyond `ReconcileGrClients` and `PrismaClientMirrorReadRepository`. Minimal footprint.

> Note: `createGrSyncRouter`'s third param being possibly-undefined is acceptable; the in-router guard keeps the type honest (`reconcileGrClients?: ReconcileGrClients`).

### AD-5 — Enum migration: forward-only `ALTER TYPE ... ADD VALUE`, NOT wrapped in BEGIN/COMMIT

**Choice**: Hand-written migration `prisma/migrations/<ts>_client_status_baja/migration.sql`:

```sql
-- Add 'baja' (GR estado.codigo 6) to ClientStatus so churned-out clients are
-- distinguishable from merely-inactive ones. Forward-only: Postgres cannot DROP
-- an enum value cleanly. Rollback = data-restamp baja→inactive, value left in place.
ALTER TYPE "ClientStatus" ADD VALUE 'baja';
```

**The transaction caveat — reality-checked**: There is an existing precedent in this exact repo: `prisma/migrations/20260514070000_add_technician_role/migration.sql` ships a bare `ALTER TYPE "AdminRole" ADD VALUE 'technician';` with **no** `BEGIN`/`COMMIT` and applies cleanly. Modern Postgres (12+) permits `ADD VALUE` inside a transaction; Prisma wraps each migration step but the statement succeeds on the target (per `env.example`, a standard `postgresql://` 12+ instance). Therefore:

- **Do NOT** add `BEGIN;`/`COMMIT;` to the file. Prisma's `migrate deploy` runs the single statement; matching the proven `add_technician_role` precedent is the safe path.
- The only hard rule from the caveat that still bites: **the newly added value cannot be USED in the same transaction as the `ADD VALUE`.** This migration only *adds* the value — it does not insert/update any row to `'baja'`. The restamp to `'baja'` happens later, asynchronously, via the next `SyncGestionRealClients` run (REQ-BAJA-RESTAMP-1) — a separate transaction. So the caveat does not apply to us.
- If a future migration ever needed to both add the value AND immediately write rows to it, it would have to be **split into two migrations**. Documented here for the next author; not needed now.

**Generation**: edit `schema.prisma` first (add `baja` to the enum), then `npm run prisma:migrate` to scaffold, then verify the generated SQL equals the one-liner above (Prisma generates exactly `ALTER TYPE "ClientStatus" ADD VALUE 'baja';`). Do not hand-edit beyond confirming the match.

**Rollback (forward-only)**: Postgres cannot drop an enum value without a full type rebuild. Rollback = a data fix that restamps `Client` rows from `'baja'` back to `'inactive'` and reverts `GR_SYNC_ESTADOS` to `1,2` (so estado-6 stops being pulled); the unused `'baja'` enum value is left in place (harmless). No destructive DDL on `Client`. This must be stated in the migration header comment.

### AD-6 — `mapStatus` + the local `ClientStatus` string-union

**Choice**: Two edits in `PrismaClientMirrorRepository.ts`:

1. **Line 5** — widen the union:
   ```ts
   type ClientStatus = 'active' | 'late' | 'blocked' | 'inactive' | 'baja';
   ```
2. **Lines 8–16** — `mapStatus`: pull `'6'` out of the `inactive` fall-through and map it to `'baja'`:
   ```ts
   function mapStatus(code: string | null): ClientStatus {
     switch (code) {
       case '1': return 'active';    // Activo
       case '2': return 'late';      // Deudor
       case '4': return 'blocked';   // Incobrable
       case '6': return 'baja';      // Baja  (was → inactive)
       case '3':                     // Inactivo
       default:  return 'inactive';  // fallback (null / '5' / unknown)
     }
   }
   ```
   `'3'` keeps falling through to `'inactive'`; `'4'`→`'blocked'` (Incobrable) unchanged; unknown/null → `'inactive'`.

**Union audit (the "any other place" check)**: The local `ClientStatus` type in `PrismaClientMirrorRepository.ts:5` is the ONLY backend string-union that mirrors the enum on the GR write path. The Prisma-generated enum (`@prisma/client`) gains `baja` automatically after migrate+generate. The `Customer`/client DTO carries `status` as a plain `string` (REQ-DTO-STRING-1) — no closed union to widen there. The frontend's `status` union lives in the sibling repo (`ipnext-frontend`) and is coordination-only, out of scope. **Apply must grep `'inactive'` across the backend** (Risk 4 in the proposal) to confirm no query special-cases inactive in a way that should now also include `baja`; if found, that's a separate, flagged follow-up — this change does not silently alter those queries.

### AD-7 — Config default + env override

**Choice**: `config.ts:43` changes its default segment only:
```ts
estados: (process.env.GR_SYNC_ESTADOS || '1,2,3,4,6').split(',').map(s => s.trim()).filter(Boolean),
```
The `|| '1,2,3,4,6'` keeps the existing "empty env string falls back to default" semantics (`||` not `??`, per the comment at `config.ts:40`). Env override is unchanged: `GR_SYNC_ESTADOS=1,2` still yields `['1','2']` (REQ-SCOPE-1). Update the inline comment at `config.ts:42` to reflect the full universe (Activo/Deudor/Inactivo/Incobrable/Baja). Also update `env.example` if it documents the default.

> This is the *only* lever that makes `baja` ever reachable: without estado 6 in scope, no client is ever fetched with `statusCode='6'`, so `mapStatus` never returns `'baja'`.

## Reality-Check Risks (where design meets reality)

1. **`GestionRealPort.fetchClients` CAN omit estado — no port change needed.** Confirmed: `estado?` is optional in `FetchClientsParams` (`GestionRealPort.ts:11`); `InMemoryGestionRealPort` filters only `if (params.estado)` (`:31`); `SyncGestionRealClients` already runs an unfiltered segment when `estados=[undefined]`. The reconcile reuses this verbatim. **No risk.**
2. **`ALTER TYPE ADD VALUE` precedent exists and is bare.** `20260514070000_add_technician_role` proves the un-wrapped one-liner applies on this stack. Low risk; the only live constraint (no same-tx use of the new value) does not apply since we add-only.
3. **Count inflation after widening scope.** Once estados 3/4/6 are pulled, `clientCount()` (all-estados) rises; the old "5119" (1,2-filtered) framing shifts. The reconcile's `grTotal` is computed over the *same* full universe → apples-to-apples. Document that the headline count changes after ship (proposal Risk 3).
4. **Restamp side effects on `'inactive'` consumers.** Re-stamping codigo-6 from `inactive`→`baja` changes a value UI filters key on. Apply MUST grep `'inactive'` backend usages; FE filter update is coordinated separately. Flagged, not silently changed.
5. **`app.ts` GR-enabled guard.** `ReconcileGrClients` depends on `grClient`, which only exists when GR is configured. The collaborator is `| undefined` and the route 503s when absent — same lifecycle as `balanceRefresh`. Acceptable; keeps the wiring honest without bloating `app.ts`.
6. **Full-universe fetch cost.** ~5k rows / 100 per page → ~50+ sequential authenticated POSTs per call. On-demand admin diagnostic only; never on a timer (that's the `gr-clients-sync-config-page` follow-up). Sequential paging, same as the sync.

## Files to Create / Modify

**Create**
- `src/domain/ports/ClientMirrorReadRepository.ts` — port: `listGrClienteIds(): Promise<string[]>`.
- `src/infrastructure/adapters/prisma/PrismaClientMirrorReadRepository.ts` — `SELECT grClienteId WHERE grClienteId NOT null` (distinct).
- `src/infrastructure/adapters/in-memory/InMemoryClientMirrorReadRepository.ts` — backed by a settable `string[]`/`Set`.
- `src/application/use-cases/ReconcileGrClients.ts` — read-only set-diff use case (ports: `GestionRealPort` + `ClientMirrorReadRepository`).
- `src/application/dto/ReconcileReportDTO.ts` — the report shape (AD-3).
- `prisma/migrations/<ts>_client_status_baja/migration.sql` — `ALTER TYPE "ClientStatus" ADD VALUE 'baja';` (AD-5).

**Modify**
- `prisma/schema.prisma:214-219` — add `baja` to `enum ClientStatus`.
- `src/infrastructure/adapters/prisma/PrismaClientMirrorRepository.ts:5` (union) and `:8-16` (`mapStatus` `6→baja`) (AD-6).
- `src/infrastructure/http/routes/gr-sync.routes.ts` — add `POST /reconcile-report` + third constructor arg (AD-4).
- `src/infrastructure/http/app.ts` — declare/assign `reconcileGrClients` in the GR-enabled block; pass to `createGrSyncRouter` (AD-4).
- `src/infrastructure/config.ts:42-43` — default `1,2,3,4,6` + comment (AD-7). `env.example` if it documents the default.

## Test Plan (STRICT TDD — red → green → refactor; in-memory ports, never mock Prisma)

Write these failing tests FIRST, in this order. Runner: `npm test` (Jest + ts-jest + supertest). Layout mirrors `src/__tests__/{application,infrastructure}/`.

1. **`src/__tests__/application/ReconcileGrClients.test.ts`** (use-case, `InMemoryGestionRealPort` + `InMemoryClientMirrorReadRepository`):
   - `localOnly = local − gr`: GR `{A,B,C}`, local `{A,B,C,X,Y}` → `localOnly=[X,Y]`, `localOnlyCount=2`, `grOnly=[]`.
   - `grOnly = gr − local`: GR `{A,B,C,Z}`, local `{A,B,C}` → `grOnly=[Z]`, `grOnlyCount=1`, `localOnly=[]`.
   - identical sets `{A,B,C}` → both diffs `[]`, both counts `0`, `localTotal===grTotal===3`.
   - **no estado filter**: GR holds clients in estados `1,2,3,4,6`; assert the recorded `gr.calls` contain NO `estado` field (full-universe), and `grTotal` counts all of them even when sync config would be `1,2`.
   - **multi-page**: seed > pageSize GR clients, set small `pageSize`; assert `grTotal` aggregates all pages (paging terminates on `offset >= total`).
   - **read-only invariant**: assert the use case constructor signature does not accept a write port (compile-time) and that no write occurs (the in-memory read repo exposes no mutators the UC could call).

2. **`src/__tests__/infrastructure/PrismaClientMirrorRepository.mapStatus.test.ts`** (or extend the existing mapper test if one exists — check first): `mapStatus('6') === 'baja'`; `'3'==='inactive'`; `'4'==='blocked'`; `null`/`'5'` → `'inactive'`. Exercise via the exported `mapStatus` or via an `upsertClient` round-trip on the in-memory mirror asserting the stored `status` string.

3. **`src/__tests__/application/ReconcileGrClients.test.ts`** (same file) — **DTO `status`/shape**: assert the returned object is a `ReconcileReportDTO` with `localOnly`/`grOnly` as `string[]` and the four numeric counts; no Prisma entity / no raw GR JSON leaks.

4. **`src/__tests__/infrastructure/gr-sync.routes.test.ts`** (extend the existing file): add a `describe('POST /api/admin/gr-sync/reconcile-report')`:
   - **200 + shape**: with auth, returns `{localTotal, grTotal, localOnlyCount, grOnlyCount, localOnly, grOnly}`; build the router with a `ReconcileGrClients` over an `InMemoryGestionRealPort` + `InMemoryClientMirrorReadRepository` seeded for a known diff.
   - **401**: no auth cookie → 401 (reuse the existing `withAuth`/no-auth pattern).

5. **(config, optional unit)** `src/__tests__/...` — assert `GR_SYNC_ESTADOS` unset → `['1','2','3','4','6']`; set to `1,2` → `['1','2']`. If config has no existing unit test, a small focused one suffices; otherwise document the behavior is covered by the scenario.

> No test mocks Prisma. Use-case tests use `InMemoryGestionRealPort` (already supports unfiltered paging) + the new `InMemoryClientMirrorReadRepository`. Route tests use supertest over an Express app with in-memory collaborators, exactly like the current `gr-sync.routes.test.ts`.

## Open Questions (carried from proposal, non-blocking)

1. `grOnly` is INCLUDED (spec REQ-REC-DIFF-1 requires it). Resolved.
2. Estado `5` (if it exists) falls through to `inactive` — preserved fallback (REQ-BAJA-MAP-1).
3. Backend `'inactive'` consumers that should also include `baja` — audit during apply (Risk 4); any change is a flagged follow-up, not silent.
4. Headline-count baseline post-widening — product decision; reconcile makes the comparison apples-to-apples regardless.
