# Tasks — gestion-real-installation-ingest

**Status**: ready
**Repo**: `ipnext-backend`
**Strict TDD**: ACTIVE — every implementation task is preceded by a failing-test task. RED → GREEN → REFACTOR.
**Test runner**: `npm test` · **Quality gate**: `npx tsc --noEmit`
**Layering**: domain ← application ← infrastructure. Ports first → use-cases (in-memory tested) → Prisma adapters → HTTP → scheduler/wiring. Never run `npm run build`.

---

## Phase 1 — Schema & Migration (additive)

- [x] 1.1 In `prisma/schema.prisma`, add `grOrdenId String? @unique` to model `ScheduledTask`
- [x] 1.2 In `prisma/schema.prisma`, add model `GestionRealIngestConfig` (`id @default("singleton")`, `enabled Boolean @default(false)`, `intervalMs Int @default(180000)`, `windowMonths Int @default(12)`, `fiberProjectId String?`, `wirelessProjectId String?`, `updatedAt DateTime @updatedAt`) with two `Project?` relations `GrIngestFiber`/`GrIngestWireless`, both `onDelete: SetNull`
- [x] 1.3 In `prisma/schema.prisma`, add back-relations to model `Project`: `grIngestFiber GestionRealIngestConfig[] @relation("GrIngestFiber")` and `grIngestWireless GestionRealIngestConfig[] @relation("GrIngestWireless")`
- [x] 1.4 Migration file generated additively via `prisma migrate diff` (no DB) at `prisma/migrations/20260529010000_gr_installation_ingest/migration.sql`; user applies it via `npm run prisma:migrate`

## Phase 2 — Domain Ports & Entities

- [x] 2.1 In `src/domain/entities/gestionReal.ts`, add `GrServiceOrder` interface (`grOrdenId`, `tipo`, `estado`, `cliente`, `contrato`, `domicilio` nullable object, `fechaCreacion`, `raw`) — optional fields `null`, never `undefined`
- [x] 2.2 In `src/domain/ports/GestionRealPort.ts`, add `GetServiceOrdersParams` (`estado?`, `fechaTipo?`, `fechaDesde?`, `fechaHasta?`) and method `getServiceOrders(params): Promise<GrServiceOrder[]>`
- [x] 2.3 Create `src/domain/ports/GrLinkResolverPort.ts` with `findClientByGrId(grClienteId): Promise<{id;name}|null>` and `findServiceByGrContratoId(grContratoId): Promise<{id;plan:string|null}|null>`
- [x] 2.4 Create `src/domain/ports/GestionRealIngestConfigRepository.ts` with `IngestConfig` type + repo interface `get()` / `update(patch)`
- [x] 2.5 In `src/domain/entities/scheduling.ts`, add `grOrdenId: string | null` to the task entity (+ `CreateTaskInput`)
- [x] 2.6 In `src/domain/ports/SchedulingRepository.ts`, add `findTaskByGrOrdenId(grOrdenId): Promise<Task|null>` and `listNeedsReview(): Promise<Task[]>`

## Phase 3 — Classifier (TDD pure fn)

- [x] 3.1 [RED] Create `src/__tests__/application/use-cases/classifyTech.test.ts` — table-driven: `"300MB"`→FIBER, `100`→FIBER, `"50/25MB"`→WIRELESS, `"20/5MB GRAL"`→WIRELESS (speed 20), `null`/`""`/`"FIBRA"`→UNCLASSIFIED; confirm FAILS
- [x] 3.2 [GREEN] Create `src/application/use-cases/classifyTech.ts` exporting `TechClass` + `classifyTech(plan)` (first integer; ≥100 FIBER, <100 WIRELESS, no number UNCLASSIFIED)

## Phase 4 — Config repo + use-cases (TDD: in-memory → use-cases → Prisma)

- [x] 4.1 [RED] Create `src/__tests__/infrastructure/adapters/in-memory/InMemoryGestionRealIngestConfigRepository.test.ts` — first `get()` returns defaults (REQ-CFG-1 scenario); `update` then `get` round-trips patch; confirm FAILS
- [x] 4.2 [GREEN] Create `src/infrastructure/adapters/in-memory/InMemoryGestionRealIngestConfigRepository.ts`
- [x] 4.3 [RED] Create `src/__tests__/application/gestion-real-ingest/GetIngestConfig.test.ts` — returns current config DTO (REQ-GETCFG-1); confirm FAILS
- [x] 4.4 [GREEN] Create `src/application/use-cases/GetIngestConfig.ts` + config DTO/mapper in `src/application/dto/gestionRealIngest.dto.ts`
- [x] 4.5 [RED] Create `src/__tests__/application/gestion-real-ingest/UpdateIngestConfig.test.ts` — updates fields (REQ-PUTCFG-1); non-existent project FK throws PROJECT_NOT_FOUND (REQ-PUTCFG-2); null clears without lookup; confirm FAILS
- [x] 4.6 [GREEN] Create `src/application/use-cases/UpdateIngestConfig.ts` (validates FK existence via project lookup port; null skips lookup)
- [x] 4.7 [GREEN] Create `src/infrastructure/adapters/prisma/PrismaGestionRealIngestConfigRepository.ts` (single-row `singleton`, returns defaults on first read)

## Phase 5 — GrLinkResolver + SchedulingRepository extensions

- [x] 5.1 [RED] Create `src/__tests__/infrastructure/adapters/in-memory/InMemoryGrLinkResolver.test.ts` — resolve client/service by GR id, miss returns `null`; confirm FAILS
- [x] 5.2 [GREEN] Create `src/infrastructure/adapters/in-memory/InMemoryGrLinkResolver.ts`
- [x] 5.3 [GREEN] Create `src/infrastructure/adapters/prisma/PrismaGrLinkResolver.ts` (Prisma read of Client by `grClienteId`, Service by `grContratoId`)
- [x] 5.4 [RED] Extend SchedulingRepository contract/in-memory tests: `findTaskByGrOrdenId` returns matching task or null; `listNeedsReview` returns only `projectId=null` REVISAR tasks; confirm FAILS
- [x] 5.5 [GREEN] Extend `InMemorySchedulingRepository` with `findTaskByGrOrdenId` + `listNeedsReview` (+ honor `grOrdenId` on create) — done in batch 1
- [x] 5.6 [GREEN] Extend `PrismaSchedulingRepository` with `findTaskByGrOrdenId` + `listNeedsReview` (+ persist `grOrdenId`); map `grOrdenId` in task DTO — done in batch 1

## Phase 6 — GR adapter `getServiceOrders`

- [x] 6.1 [RED] Create `src/__tests__/infrastructure/adapters/gestion-real/parseServiceOrdersResponse.test.ts` — dict `{ "551":{...}, "552":{...} }`→2 orders each with id (REQ-SRC-1); missing `domicilio`→`null` (REQ-SRC-2); confirm FAILS
- [x] 6.2 [GREEN] In `src/infrastructure/adapters/gestion-real/GestionRealClient.ts`, add exported pure `parseServiceOrdersResponse(raw)`
- [x] 6.3 [GREEN] In `GestionRealClient.ts`, implement `getServiceOrders` (daily-MD5 Basic auth, action `ordenesdeservicio`, sends `estado`/`fecha_tipo`/window, normalizes via parser)
- [x] 6.4 [GREEN] In `src/infrastructure/adapters/in-memory/InMemoryGestionRealPort.ts`, add `getServiceOrders` returning a settable fixture batch (use-case test fake) — done in batch 1

## Phase 7 — IngestGestionRealOrders use-case (TDD)

- [x] 7.1 [RED] Create `src/__tests__/application/gestion-real-ingest/IngestGestionRealOrders.test.ts` wiring in-memory `GestionRealPort` + `InMemoryGrLinkResolver` + `InMemorySchedulingRepository` + `InMemoryGestionRealIngestConfigRepository` + `InMemorySyncStateRepository` (NO Prisma mocks), covering:
  - CI filter: 1 CI + 2 CO → only CI considered (REQ-FILTER-1)
  - Happy fiber: plan `"300MB"`, `fiberProjectId="p-fiber"` → task with FKs + `projectId="p-fiber"` + `grOrdenId` (REQ-CREATE-1)
  - Happy wireless: plan `"50/25MB"`, `wirelessProjectId="p-wifi"` → `projectId="p-wifi"` (REQ-CREATE-2)
  - Unclassified: no-number plan → task `projectId=null`, title prefix `[REVISAR - Logística] Instalación`, reason in description, counted `unclassified` (REQ-CREATE-3)
  - Unmirrored: missing service → skipped+counted `skippedUnmirrored`, batch continues, no throw, other order still created (REQ-FK-2)
  - Idempotent re-run: order already has task with `grOrdenId` → no new task, counted `skippedDuplicate` (REQ-IDEMP-1)
  - After run: SyncState `gr-ingest` saved with `lastRunAt` + counts blob
  - Confirm all FAIL
- [x] 7.2 [GREEN] Create `src/application/use-cases/IngestGestionRealOrders.ts` + `IngestRunResult` DTO — orchestrates fetch(window from config)→filter CI→resolve FKs→classify→resolve target project→`findTaskByGrOrdenId` idempotency→create or skip→counts→save SyncState (`entity:'gr-ingest'`)
- [x] 7.3 [GREEN] Resolve initial stage via `SchedulingRepository.getStageByName('Pendiente', project.workflowId)` with default-pending fallback (needs-review uses global default)

## Phase 8 — Status & Needs-Review use-cases (TDD)

- [x] 8.1 [RED] Create `src/__tests__/application/gestion-real-ingest/GetIngestStatus.test.ts` — reflects last run counts (REQ-STATUS-1); before any run → `lastRunAt=null`, all counts `0`; confirm FAILS
- [x] 8.2 [GREEN] Create `src/application/use-cases/GetIngestStatus.ts` (reads `gr-ingest` SyncState, parses counts blob, status DTO + mapper)
- [x] 8.3 [RED] Create `src/__tests__/application/gestion-real-ingest/ListNeedsReviewTasks.test.ts` — returns only needs-review DTOs (REQ-REVIEW-1); empty → `[]`; confirm FAILS
- [x] 8.4 [GREEN] Create `src/application/use-cases/ListNeedsReviewTasks.ts` (uses `SchedulingRepository.listNeedsReview`, maps to task DTO)

## Phase 9 — HTTP routes (TDD supertest)

- [x] 9.1 [RED] Create `src/__tests__/infrastructure/http/routes/gestionRealIngest.routes.test.ts` (supertest + in-memory adapters):
  - `GET /api/gestion-real-ingest/config` → 200 DTO, no raw entity (REQ-GETCFG-1)
  - `PUT .../config` valid body → 200 updated DTO (REQ-PUTCFG-1)
  - `PUT .../config` `intervalMs:"soon"` → 400 `VALIDATION_ERROR`
  - `PUT .../config` `{wirelessProjectId:"ghost"}` → 404 `PROJECT_NOT_FOUND`, unchanged (REQ-PUTCFG-2)
  - `PUT .../config` `{wirelessProjectId:null}` → 200 null, no lookup
  - `GET .../status` after run → 200 counts; before run → `lastRunAt=null`, zeros (REQ-STATUS-1)
  - `GET .../needs-review` → 200 array of needs-review only; empty `[]` (REQ-REVIEW-1)
  - Confirm all FAIL
- [x] 9.2 [GREEN] Create `src/infrastructure/http/routes/gestionRealIngest.routes.ts` — `createGestionRealIngestRouter(authProvider, getIngestConfig, updateIngestConfig, getIngestStatus, listNeedsReviewTasks)`; GET/PUT config, GET status, GET needs-review; all responses via DTO mappers
- [x] 9.3 [GREEN] Confirm global error handler maps `PROJECT_NOT_FOUND`→404 and `VALIDATION_ERROR`→400 (add if missing) — `PROJECT_NOT_FOUND` already in `errorHandler` statusMap (404); `VALIDATION_ERROR` (400) emitted inline by the route via Zod `safeParse`, matching the repo convention

## Phase 10 — Scheduler + bootstrap + app wiring

- [x] 10.1 [RED] Create `src/__tests__/infrastructure/scheduling/GestionRealIngestScheduler.test.ts` (InMemoryDistributedLock + fake config): config `enabled=false` → ingest NOT invoked (REQ-SCHED-2); lock held → tick skips (REQ-SCHED-1); enabled+lock-free → ingest runs once; confirm FAILS
- [x] 10.2 [GREEN] Create `src/infrastructure/scheduling/GestionRealIngestScheduler.ts` — mirror `GestionRealSyncScheduler` (interval from config, `inFlight` guard, advisory lock key `gr-ingest`, runs only when `config.get().enabled`, swallows per-cycle errors)
- [x] 10.3 [GREEN] Create `src/infrastructure/scheduling/bootstrapGestionRealIngest.ts` — composition root building client, `PrismaGrLinkResolver`, config repo, scheduling repo, sync-state repo, advisory lock, `IngestGestionRealOrders`, scheduler; returns `null` when GR creds missing (async: resolves fallback `defaultStageId` via `getStageByName('Pendiente')`)
- [x] 10.4 [GREEN] In `src/main.ts`, add `bootstrapGestionRealIngest().then(grIngest => grIngest?.start())` (mirror `grSync`; awaited via `.then` since bootstrap is async)
- [x] 10.5 [GREEN] In `src/infrastructure/http/app.ts`, instantiate the config/status/review use-cases and wire one line `app.use('/api/gestion-real-ingest', createGestionRealIngestRouter(...))`

## Phase 11 — Quality Gates

- [x] 11.1 Run feature test set — GREEN (14 suites, 84 tests). Full suite: 1383 passed / 9 skipped / 0 failed tests; 12 suites fail to LOAD on the pre-existing Prisma-client-not-generated env baseline (unchanged, not regressions)
- [x] 11.2 Run `npx tsc --noEmit` — 19 errors = exact pre-existing RBAC/Prisma baseline; net-new delta 0 (no new/wired file appears)
- [x] 11.3 Draft conventional commit (user commits): `feat(gr-ingest): ingest GR installation orders into ScheduledTask with classifier, config, scheduler & routes`

---

## Task Summary

| Phase | Focus | Type | Count |
|-------|-------|------|-------|
| 1 | Schema & migration | additive | 4 |
| 2 | Domain ports & entities | GREEN | 6 |
| 3 | Classifier | RED+GREEN | 2 |
| 4 | Config repo + use-cases | RED+GREEN | 7 |
| 5 | GrLinkResolver + Scheduling ext | RED+GREEN | 6 |
| 6 | GR adapter getServiceOrders | RED+GREEN | 4 |
| 7 | IngestGestionRealOrders UC | RED+GREEN | 3 |
| 8 | Status & needs-review UCs | RED+GREEN | 4 |
| 9 | HTTP routes | RED+GREEN | 3 |
| 10 | Scheduler + bootstrap + wiring | RED+GREEN | 5 |
| 11 | Quality gates | gate | 3 |
| **Total** | | | **47 tasks** |

**Phases**: 11 · dependency-ordered: schema → domain → classifier → config → resolver/scheduling → GR adapter → ingest UC → status/review UCs → routes → scheduler/wiring → gates.
