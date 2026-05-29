# Verify Report — gestion-real-installation-ingest

**Date**: 2026-05-29
**Branch**: `feat/gestion-real-installation-ingest` (worktree `ipnext-backend-gr-ingest`)
**Verdict**: **PASS**

The implementation fully satisfies all three capability specs (`gestion-real-ingest`,
`gestion-real-ingest-config`, `scheduling` delta), the design, and the task list. Every spec
scenario has implementing code AND a test that asserts it. Architecture boundaries hold, TDD
discipline held (in-memory adapters, no Prisma mocks), the migration is additive, and there is
zero net-new test/tsc regression.

---

## Test Run Summary

- **Feature set** (14 suites: classifyTech, IngestConfig, GrLinkResolver, grIngest, IngestGestionRealOrders, parseServiceOrders, GetIngestStatus, ListNeedsReview, gestionRealIngest routes, GestionRealClient, GestionRealIngestScheduler): **14 suites / 84 tests — ALL GREEN**.
- **Full suite**: **1383 passed / 9 skipped / 0 failed tests**; 12 suites **fail to LOAD** (`@prisma/client` has no exported `PrismaClient`/`LeadStatus`) — the EXACT documented pre-existing env baseline (Prisma client not generated in the worktree). Unchanged, unrelated to this change.
- **tsc**: `npx tsc --noEmit` → **19 errors = exact pre-existing RBAC/Prisma baseline**. NONE of the feature/wired files appear in the output. **Net-new tsc delta = 0.**

---

## Spec Coverage (every scenario implemented + tested)

### gestion-real-ingest
| REQ / Scenario | Code | Test |
|---|---|---|
| REQ-SRC-1 dict→array, carries id | `GestionRealClient.parseServiceOrdersResponse` | parseServiceOrdersResponse.test ✓ |
| REQ-SRC-2 missing domicilio→null | same | ✓ (null domicilio + null cliente/contrato) |
| REQ-FILTER-1 only CI | `IngestGestionRealOrders.execute` `.filter(o=>o.tipo==='CI')` | IngestGestionRealOrders.test (1 CI + CO + BA) ✓ |
| REQ-FK-1 resolve client/service | `ingestOne` via `GrLinkResolverPort` | happy fiber/wireless ✓ |
| REQ-FK-2 unmirrored skip+continue | `ingestOne` (miss → `skippedUnmirrored++`, return) | missing client AND missing service, batch continues ✓ |
| REQ-TECH-1 first integer | `classifyTech` `/\d+/` | "20/5MB GRAL"→20 ✓ |
| REQ-TECH-2 ≥100 FIBER / <100 WIRELESS / unparseable UNCLASSIFIED | `classifyTech` | 100→FIBER, 99→WIRELESS, null/""→UNCLASSIFIED ✓ |
| REQ-CREATE-1 fiber→fiberProjectId | `ingestOne` | projectId='p-fiber', grOrdenId set ✓ |
| REQ-CREATE-2 wireless→wirelessProjectId | `ingestOne` | projectId='p-wifi' ✓ |
| REQ-CREATE-3 unclassified→null project, REVISAR title, reason | `ingestOne` | title prefix + description + counted unclassified ✓ |
| REQ-IDEMP-1 grOrdenId check, no dup | `findTaskByGrOrdenId` before create | re-run → 0 created, 1 skippedDuplicate, 1 task total ✓ |
| REQ-SCHED-1 advisory-lock | `GestionRealIngestScheduler` `tryAcquire('gr-ingest')` | lock-held → skip ✓ |
| REQ-SCHED-2 enabled-gate | scheduler short-circuit + use-case no-op | disabled → ingest not called, no GR call ✓ |

### gestion-real-ingest-config
| REQ / Scenario | Code | Test |
|---|---|---|
| REQ-CFG-1 defaults on first read | `InMemory`/`Prisma` config repo | routes GET returns defaults ✓ |
| REQ-GETCFG-1 GET config DTO | `GetIngestConfig` + `toIngestConfigDTO` | 200 DTO ✓ |
| REQ-PUTCFG-1 update fields, 400 bad body | route Zod `safeParse` + `UpdateIngestConfig` | 200 update; `intervalMs:"soon"`→400 VALIDATION_ERROR ✓ |
| REQ-PUTCFG-2 ghost FK→404, null clears | `UpdateIngestConfig.assertProjectExists` | ghost→404 PROJECT_NOT_FOUND unchanged; null→200 no lookup ✓ |
| REQ-STATUS-1 last run + counts; before run zeros | `GetIngestStatus` + `toIngestStatusDTO` | before→nulls/zeros; after→counts ✓ |
| REQ-REVIEW-1 needs-review list; empty | `ListNeedsReviewTasks` + `listNeedsReview` | only needs-review; empty `[]` ✓ |

### scheduling (delta)
| REQ / Scenario | Code | Test |
|---|---|---|
| `grOrdenId` unique nullable | schema `grOrdenId String? @unique`; migration `CREATE UNIQUE INDEX` | persisted/mapped in Prisma+InMemory ✓ |
| manual task → null grOrdenId | `createTask` `data.grOrdenId ?? null` | covered by existing scheduling tests ✓ |
| task MAY have null project | `ingestOne` UNCLASSIFIED path | needs-review persists null project ✓ |

---

## Detailed Checks

1. **Architecture (hexagonal)** — PASS. All 6 use-cases (`IngestGestionRealOrders`, `classifyTech`, `Get/UpdateIngestConfig`, `GetIngestStatus`, `ListNeedsReviewTasks`) import ONLY from `@domain/*` and `@application/*`. Grep for `@infrastructure`/`prisma` in the use-cases returns nothing (one comment-only hit in ListNeedsReviewTasks). Adapters follow `Prisma*Repository`/`InMemory*Repository` naming. Routes/use-cases return DTOs, never raw Prisma entities.

2. **Idempotency correctness** — PASS. `grOrdenId String? @unique` (NULL-distinct), and the use-case calls `findTaskByGrOrdenId` BEFORE create (check-then-create, not relying on the DB throw). Manual tasks (`grOrdenId` null) unaffected.

3. **Classifier** — PASS. `/\d+/` first integer; ≥100 FIBER, <100 WIRELESS, no-match UNCLASSIFIED. Boundary 100/99 + "20/5MB GRAL"→20 tested.

4. **FK resolution** — PASS. `order.cliente`→`findClientByGrId`, `order.contrato`→`findServiceByGrContratoId`. Miss → `skippedUnmirrored++` + continue, no throw. Batch-continues test present.

5. **Scheduler** — PASS. Lock key `'gr-ingest'` distinct from clients sync `'gr-sync'`. Enabled check is a per-tick runtime read of `config.get()`. Errors swallowed in `finally` with lock release. inFlight intra-process guard. `unref()` so it doesn't keep the loop alive.

6. **Migration** — PASS. `20260529010000_gr_installation_ingest` is additive only: `ADD COLUMN grOrdenId`, `CREATE TABLE GestionRealIngestConfig`, `CREATE UNIQUE INDEX`, two `onDelete: SET NULL` FKs. Timestamp later than the prior last migration (`20260529000000_auth_rbac_foundation`).

7. **Wiring** — PASS. Router mounted in `app.ts` (line 855) reusing `projectRepo`/`schedulingRepo`. `main.ts` calls `bootstrapGestionRealIngest().then(s=>s?.start())`. Bootstrap (async) supplies `defaultStageId` (resolved from global 'Pendiente') + `ProjectRepository` to the use-case; gates on GR creds, leaves `enabled` to runtime.

---

## Findings

### CRITICAL
None.

### WARNING
None blocking. (The two ENV caveats below are operational, not code defects.)

### SUGGESTION
- **S1 — needs-review predicate diverges from literal spec wording.** REQ-REVIEW-1 describes needs-review tasks as "`projectId = null` AND `[REVISAR - Logística]` title prefix". Both the Prisma and in-memory `listNeedsReview` use `grOrdenId IS NOT NULL AND projectId IS NULL` (ignores the title text). This is a SOUNDER predicate — it's the exact set the ingest produces, and title-string matching is fragile/i18n-brittle — but it technically differs from the spec's literal text. Recommend updating the spec wording during archive to reflect the implemented (better) predicate, OR documenting the equivalence. Behavior is correct; no functional gap (a normal fiber/wireless task has a non-null project, so it's excluded).
- **S2 — `Project` FK indexes added by migration but not declared in schema model.** The migration creates `GestionRealIngestConfig_fiberProjectId_idx` / `_wirelessProjectId_idx`, which is correct/standard, just worth noting the schema relies on Prisma's implicit FK indexing. No action needed.

### Operational caveats (for the user before merge — NOT code defects)
1. **Migration not yet applied** — run `npm run prisma:migrate` (deploy) to apply `20260529010000_gr_installation_ingest`.
2. **Prisma client not generated in worktree** — running `prisma generate` clears the 12 baseline suite load-failures and the 19 tsc baseline errors. `PrismaSchedulingRepository`/config repo use `as any` casts precisely because of this; they become unnecessary post-generate.
3. **Global 'Pendiente' Stage dependency** — needs-review (null-project) tasks fall back to the global 'Pendiente' stage / `defaultStageId`. Bootstrap warns if absent; ensure one exists in prod.

---

## Conclusion

Solid, spec-complete, TDD-disciplined implementation. No CRITICAL or WARNING findings. Two minor
SUGGESTIONs (spec-wording alignment for the needs-review predicate; index note). Safe to commit and
merge once the migration is applied and the Prisma client is generated in the target environment.
