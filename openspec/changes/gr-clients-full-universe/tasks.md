# Tasks — gr-clients-full-universe

Three independent, additive seams: (1) a read-only reconcile use case + endpoint, (2) a one-line `GR_SYNC_ESTADOS` scope widening, (3) a first-class `baja` status (enum + `mapStatus` + string-union). NO deletions, NO destructive DDL. STRICT TDD: every implementation task is preceded by its failing test (red → green → refactor). Use-case tests use in-memory ports (`InMemoryGestionRealPort` + new `InMemoryClientMirrorReadRepository`); routes via supertest. NEVER mock Prisma. Quality gate: `npm test` green + `tsc --noEmit` clean. Per project rule: do NOT run `npm run build`; do NOT run `prisma migrate` against any DB (deploy pipeline applies it).

## Phase 1 — Read-only local-ids port (AD-1) — no upstream deps

- [x] 1.1 (TEST, red) `src/__tests__/infrastructure/InMemoryClientMirrorReadRepository.test.ts`: seed a `string[]`/`Set` of `grClienteId`s; assert `listGrClienteIds()` returns exactly those ids; exposes NO mutators a read-only consumer could misuse.
- [x] 1.2 Create the domain port `src/domain/ports/ClientMirrorReadRepository.ts` — interface with `listGrClienteIds(): Promise<string[]>` only (ISP: separate from `MirrorCountsRepository` and the write `ClientMirrorRepository`).
- [x] 1.3 Create `src/infrastructure/adapters/in-memory/InMemoryClientMirrorReadRepository.ts` — backed by a settable `string[]`/`Set`; implements the port. → makes 1.1 green.
- [x] 1.4 Create `src/infrastructure/adapters/prisma/PrismaClientMirrorReadRepository.ts` — `SELECT grClienteId WHERE grClienteId NOT null`, distinct, returns `string[]`. (No unit test — Prisma never mocked; covered structurally + by the route DEPLOY gate.)
- [x] 1.5 `tsc --noEmit` clean; `npm test` green for Phase 1.

## Phase 2 — `ReconcileReportDTO` + `ReconcileGrClients` use case (AD-2, AD-3) — depends on Phase 1

- [x] 2.1 (TEST, red) `src/__tests__/application/ReconcileGrClients.test.ts` over `InMemoryGestionRealPort` + `InMemoryClientMirrorReadRepository`. Cases (one `it` each):
  - **localOnly = local − gr**: GR `{A,B,C}`, local `{A,B,C,X,Y}` → `localOnly=[X,Y]`, `localOnlyCount=2`, `grOnly=[]`, `grOnlyCount=0`.
  - **grOnly = gr − local**: GR `{A,B,C,Z}`, local `{A,B,C}` → `grOnly=[Z]`, `grOnlyCount=1`, `localOnly=[]`.
  - **identical sets** `{A,B,C}` → both diffs `[]`, both counts `0`, `localTotal===grTotal===3`.
  - **no estado filter** (REQ-REC-DIFF-1): GR holds clients across `statusCode` `1,2,3,4,6`; assert every recorded `gr.calls` entry has `estado === undefined` AND `grTotal` counts ALL of them (even if sync config were `1,2`).
  - **multi-page** (REQ-REC-PAGINATION-1): seed > pageSize GR clients, pass a small `pageSize` via the options bag; assert `grTotal` aggregates all pages and paging terminates on `offset >= total`.
  - **DTO shape** (REQ-REC-PORT-1): returned object is a `ReconcileReportDTO` — `localOnly`/`grOnly` are `string[]`, the four counts are numbers; no Prisma entity / no raw GR JSON leaks.
- [x] 2.2 Create `src/application/dto/ReconcileReportDTO.ts` — `{ localTotal, grTotal, localOnlyCount, grOnlyCount, localOnly: string[], grOnly: string[] }` (AD-3).
- [x] 2.3 Implement `src/application/use-cases/ReconcileGrClients.ts` — inject ONLY `GestionRealPort` + `ClientMirrorReadRepository` (no write port → REQ-REC-READONLY-1 by construction). Paginated full-universe fetch: `params = { cantidad: pageSize, offset }` with NO `estado`/date fields; accumulate `clients.map(c => c.grClienteId)`; `offset += pageSize`; break on `clients.length === 0 || offset >= total`. `pageSize` defaults to `100` (DEFAULT_PAGE_SIZE), overridable via an options bag for tests. Set-diff with `Set`: `localOnly = localIds.filter(id => !grSet.has(id))`, `grOnly = grIds.filter(id => !localSet.has(id))`; `localTotal = localSet.size`, `grTotal = grSet.size`. Return `ReconcileReportDTO`. MUST NOT read `config.gestionReal.estados`. → makes 2.1 green.
- [x] 2.4 Refactor/verify: confirm `ReconcileGrClients` imports nothing from `@infrastructure/*` or Prisma (DIP). `tsc --noEmit` clean; `npm test` green.

## Phase 3 — Endpoint + app.ts wiring (AD-4) — depends on Phase 2

- [x] 3.1 (TEST, red) Extend `src/__tests__/infrastructure/gr-sync.routes.test.ts` with `describe('POST /api/admin/gr-sync/reconcile-report')`:
  - **200 + shape** (REQ-REC-ENDPOINT-1): build the router with a real `ReconcileGrClients` over `InMemoryGestionRealPort` + `InMemoryClientMirrorReadRepository` seeded for a known diff; authenticated request → `200` with `{localTotal, grTotal, localOnlyCount, grOnlyCount, localOnly, grOnly}`; assert `localOnlyCount === localOnly.length` and `grOnlyCount === grOnly.length`.
  - **401** (REQ-REC-AUTH-1): no auth cookie/token → `401` (reuse the existing no-auth pattern in this file).
- [x] 3.2 Modify `src/infrastructure/http/routes/gr-sync.routes.ts`: add third param `reconcileGrClients?: ReconcileGrClients` to `createGrSyncRouter`; add `router.post('/reconcile-report', auth, ...)` that 503s when the collaborator is absent (GR not configured), else `res.json(await reconcileGrClients.execute())`. Both routes share the same `auth`. → makes 3.1 green.
- [x] 3.3 Modify `src/infrastructure/http/app.ts`: declare `let reconcileGrClients: ReconcileGrClients | undefined` next to `balanceRefresh` (~`app.ts:451`); assign it inside the GR-enabled block where `grClient` is in scope (`new ReconcileGrClients(grClient, new PrismaClientMirrorReadRepository())`); pass it as the third arg to `createGrSyncRouter` (~`app.ts:832-835`). Net ~2 new lines + 2 new imports. Verify the route 503s when GR is off.
- [x] 3.4 `tsc --noEmit` clean; `npm test` green. ✅ **DEPLOY GATE: read-only reconcile endpoint live; zero data impact.**

## Phase 4 — `baja` enum migration + schema (AD-5) — independent of Phase 1–3

- [ ] 4.1 Edit `prisma/schema.prisma:214-219`: add `baja` to `enum ClientStatus` (after `inactive`).
- [ ] 4.2 Create the migration `prisma/migrations/<ts>_client_status_baja/migration.sql` by hand — bare, NO `BEGIN`/`COMMIT` wrap, mirroring the precedent `20260514070000_add_technician_role/migration.sql`:
  ```sql
  ALTER TYPE "ClientStatus" ADD VALUE 'baja';
  ```
  Header comment MUST state: forward-only (Postgres cannot cleanly DROP an enum value); rollback = restamp `baja`→`inactive` + revert `GR_SYNC_ESTADOS` to `1,2`, leaving the unused value in place; this migration only ADDs the value (no row uses it in the same tx, so the same-tx caveat does not apply). ⚠ Do NOT run `prisma migrate` — the deploy pipeline applies it.
- [ ] 4.3 Regenerate the Prisma client locally so `@prisma/client` gains `baja` (so `tsc --noEmit` sees the widened enum). `tsc --noEmit` clean.

## Phase 5 — `mapStatus` 6→baja + local string-union (AD-6) — depends on Phase 4

- [ ] 5.1 (TEST, red) `src/__tests__/infrastructure/PrismaClientMirrorRepository.mapStatus.test.ts` (check first whether a mapper test already exists and extend it instead): `mapStatus('6') === 'baja'`; `mapStatus('3') === 'inactive'`; `mapStatus('4') === 'blocked'`; `mapStatus('1') === 'active'`; `mapStatus('2') === 'late'`; `mapStatus('5')` and `mapStatus(null)` → `'inactive'`. If `mapStatus` is not exported, exercise via an `upsertClient` round-trip on the in-memory mirror asserting the stored `status` string (never mock Prisma).
- [ ] 5.2 Modify `PrismaClientMirrorRepository.ts:5` — widen union to `type ClientStatus = 'active' | 'late' | 'blocked' | 'inactive' | 'baja';`.
- [ ] 5.3 Modify `PrismaClientMirrorRepository.ts:8-16` — pull `'6'` out of the `inactive` fall-through into `case '6': return 'baja';`; keep `'3'`→`'inactive'`, `'4'`→`'blocked'`, null/unknown→`'inactive'`. → makes 5.1 green.
- [ ] 5.4 `tsc --noEmit` clean; `npm test` green.

## Phase 6 — Config scope widening (AD-7) — independent

- [ ] 6.1 (TEST, red, optional) If a config unit test exists, add: `GR_SYNC_ESTADOS` unset → `['1','2','3','4','6']`; `GR_SYNC_ESTADOS=1,2` → `['1','2']`. If none exists, a small focused test suffices; otherwise note this is covered by the spec scenarios and skip.
- [ ] 6.2 Modify `src/infrastructure/config.ts:42-43`: change the default segment `'1,2'` → `'1,2,3,4,6'` (keep `||`, NOT `??`, per the existing comment); update the inline comment to list Activo/Deudor/Inactivo/Incobrable/Baja. → makes 6.1 green.
- [ ] 6.3 Update `env.example` where `GR_SYNC_ESTADOS` is documented — note new default `1,2,3,4,6` and the full-universe meaning.
- [ ] 6.4 `tsc --noEmit` clean; `npm test` green.

## Phase 7 — `'inactive'` consumer audit (Risk 4 / AD-6) — depends on Phase 5

- [ ] 7.1 Grep the backend (`src/`) for `'inactive'` usages (queries, filters, reports) that special-case inactive and might now also need to handle `baja`. ⚠ **FLAG findings as a separate follow-up — do NOT silently change any query in this change.** Record the list in the verify report / engram. (Frontend filter update is coordinated separately, out of scope.)

## Verification Checklist

- [x] V.1 `npm test` fully green (all new + existing suites).
- [x] V.2 `tsc --noEmit` clean.
- [x] V.3 `ReconcileGrClients` imports nothing from `@infrastructure/*` or Prisma; receives no write port (DIP + REQ-REC-READONLY-1 by construction).
- [x] V.4 Reconcile fetches with NO `estado` filter (asserted via `gr.calls`); `grTotal` covers the full universe regardless of `GR_SYNC_ESTADOS`.
- [x] V.5 `POST /api/admin/gr-sync/reconcile-report`: 200 + correct shape with auth; 401 without; 503 when GR disabled.
- [ ] V.6 Migration is bare `ALTER TYPE ... ADD VALUE 'baja'` (no tx wrap), matches `add_technician_role` precedent, header documents forward-only rollback. NOT applied locally.
- [ ] V.7 `mapStatus('6') === 'baja'`; `'3'`/`'4'`/null/unknown unchanged; local `ClientStatus` union includes `'baja'`.
- [ ] V.8 `GR_SYNC_ESTADOS` default is `['1','2','3','4','6']`; env override still wins; `env.example` updated.
- [ ] V.9 `'inactive'` consumer audit completed and any hits flagged (not changed).
- [ ] V.10 No deletions, no destructive DDL, no `npm run build`, no `prisma migrate` against a DB executed.
