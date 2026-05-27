# Tasks: naming-cleanup

## Definitive File Count (resolved Open Question)

**26 files** in `src/infrastructure/adapters/prisma/`:
- **24 need class rename** (`InMemory*` → `Prisma*`):
  PrismaAdminRepository, PrismaClientCommentRepository, PrismaCpeRepository,
  PrismaCreditNoteRepository, PrismaDashboardRepository, PrismaEmpresaRepository,
  PrismaFinanceHistoryRepository, PrismaGponRepository, PrismaHardwareRepository,
  PrismaIpNetworkRepository, PrismaLeadRepository, PrismaMessageRepository,
  PrismaNasRepository, PrismaNetworkSiteRepository, PrismaNotificationRepository,
  PrismaPartnerRepository, PrismaProformaRepository, PrismaRadiusSessionRepository,
  PrismaRoleRepository, PrismaSchedulingRepository, PrismaSettingsRepository,
  PrismaTr069Repository, PrismaUbicacionRepository, PrismaVozRepository
- **2 already correct** (no change needed):
  PrismaMonitoringRepository, PrismaProjectRepository

**app.ts**: 52 references (imports + instantiations) of `InMemory*` from prisma adapters.
**DIP violations**: 3 use-cases import `InMemoryReportRepository` from `@infrastructure/*`.

---

## Phase 1 — Baseline Verification

- [x] 1.1 Run `npm test` and confirm all 321 tests pass. Record output. *(~3 min)*
- [x] 1.2 Run `npx tsc --noEmit` and confirm 0 errors (after `prisma generate`). *(~1 min)*

**BASELINE: tsc 0 errors | npm test 321/321 (61 suites)**

---

## Phase 2 — Commit 1: Rename InMemory* Classes in Prisma Adapters

Rename class (not file) in each of the 24 files. Use `sd 'class InMemoryXxxRepository' 'class PrismaXxxRepository'` or targeted edit per file.

- [x] 2.1 `src/infrastructure/adapters/prisma/PrismaAdminRepository.ts` — rename `class InMemoryAdminRepository` → `class PrismaAdminRepository`. Edit, no test required (structural). *(~2 min)*
- [x] 2.2 `src/infrastructure/adapters/prisma/PrismaClientCommentRepository.ts` — rename `class InMemoryClientCommentRepository` → `class PrismaClientCommentRepository`. *(~2 min)*
- [x] 2.3 `src/infrastructure/adapters/prisma/PrismaCpeRepository.ts` — rename `class InMemoryCpeRepository` → `class PrismaCpeRepository`. *(~2 min)*
- [x] 2.4 `src/infrastructure/adapters/prisma/PrismaCreditNoteRepository.ts` — rename `class InMemoryCreditNoteRepository` → `class PrismaCreditNoteRepository`. *(~2 min)*
- [x] 2.5 `src/infrastructure/adapters/prisma/PrismaDashboardRepository.ts` — rename `class InMemoryDashboardRepository` → `class PrismaDashboardRepository`. *(~2 min)*
- [x] 2.6 `src/infrastructure/adapters/prisma/PrismaEmpresaRepository.ts` — rename `class InMemoryEmpresaRepository` → `class PrismaEmpresaRepository`. *(~2 min)*
- [x] 2.7 `src/infrastructure/adapters/prisma/PrismaFinanceHistoryRepository.ts` — rename `class InMemoryFinanceHistoryRepository` → `class PrismaFinanceHistoryRepository`. *(~2 min)*
- [x] 2.8 `src/infrastructure/adapters/prisma/PrismaGponRepository.ts` — rename `class InMemoryGponRepository` → `class PrismaGponRepository`. *(~2 min)*
- [x] 2.9 `src/infrastructure/adapters/prisma/PrismaHardwareRepository.ts` — rename `class InMemoryHardwareRepository` → `class PrismaHardwareRepository`. *(~2 min)*
- [x] 2.10 `src/infrastructure/adapters/prisma/PrismaIpNetworkRepository.ts` — rename `class InMemoryIpNetworkRepository` → `class PrismaIpNetworkRepository`. IPv6 JSDoc debt added above class. *(~3 min)*
- [x] 2.11 `src/infrastructure/adapters/prisma/PrismaLeadRepository.ts` — rename `class InMemoryLeadRepository` → `class PrismaLeadRepository`. *(~2 min)*
- [x] 2.12 `src/infrastructure/adapters/prisma/PrismaMessageRepository.ts` — rename `class InMemoryMessageRepository` → `class PrismaMessageRepository`. *(~2 min)*
- [x] 2.13 `src/infrastructure/adapters/prisma/PrismaNasRepository.ts` — rename `class InMemoryNasRepository` → `class PrismaNasRepository`. *(~2 min)*
- [x] 2.14 `src/infrastructure/adapters/prisma/PrismaNetworkSiteRepository.ts` — rename `class InMemoryNetworkSiteRepository` → `class PrismaNetworkSiteRepository`. *(~2 min)*
- [x] 2.15 `src/infrastructure/adapters/prisma/PrismaNotificationRepository.ts` — rename `class InMemoryNotificationRepository` → `class PrismaNotificationRepository`. *(~2 min)*
- [x] 2.16 `src/infrastructure/adapters/prisma/PrismaPartnerRepository.ts` — rename `class InMemoryPartnerRepository` → `class PrismaPartnerRepository`. *(~2 min)*
- [x] 2.17 `src/infrastructure/adapters/prisma/PrismaProformaRepository.ts` — rename `class InMemoryProformaRepository` → `class PrismaProformaRepository`. *(~2 min)*
- [x] 2.18 `src/infrastructure/adapters/prisma/PrismaRadiusSessionRepository.ts` — rename `class InMemoryRadiusSessionRepository` → `class PrismaRadiusSessionRepository`. *(~2 min)*
- [x] 2.19 `src/infrastructure/adapters/prisma/PrismaRoleRepository.ts` — rename `class InMemoryRoleRepository` → `class PrismaRoleRepository`. *(~2 min)*
- [x] 2.20 `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts` — rename `class InMemorySchedulingRepository` → `class PrismaSchedulingRepository`. *(~2 min)*
- [x] 2.21 `src/infrastructure/adapters/prisma/PrismaSettingsRepository.ts` — rename `class InMemorySettingsRepository` → `class PrismaSettingsRepository`. *(~2 min)*
- [x] 2.22 `src/infrastructure/adapters/prisma/PrismaTr069Repository.ts` — rename `class InMemoryTr069Repository` → `class PrismaTr069Repository`. *(~2 min)*
- [x] 2.23 `src/infrastructure/adapters/prisma/PrismaUbicacionRepository.ts` — rename `class InMemoryUbicacionRepository` → `class PrismaUbicacionRepository`. *(~2 min)*
- [x] 2.24 `src/infrastructure/adapters/prisma/PrismaVozRepository.ts` — rename `class InMemoryVozRepository` → `class PrismaVozRepository`. *(~2 min)*
- [x] 2.25 `src/infrastructure/http/app.ts` — updated all 24 import lines + 24 instantiation calls. Remaining InMemory refs are from `adapters/in-memory/` (legitimate). *(~10 min)*
- [x] 2.26 Run `rg "class InMemory.*Repository" src/infrastructure/adapters/prisma/` → 0 results. *(CONFIRMED)*
- [x] 2.27 Run `npx tsc --noEmit` → 0 errors. *(CONFIRMED)*
- [x] 2.28 Run `npm test` → 321/321 passing. *(CONFIRMED)*
- [x] 2.29 Commit: `refactor(adapters): rename Prisma*.ts InMemory* classes to Prisma*Repository` — SHA: f6585e2a

---

## Phase 3 — Commit 2: ReportRepository Port + DIP Fix

> STRICT TDD is enabled. For the port contract, write a failing compile-time test first (type-check test), then implement, then verify green.

- [x] 3.1 Create `src/domain/ports/ReportRepository.ts` — export interface `ReportRepository` with methods `getDefinitions(): ReportDefinition[]` and `generateReport(type: ReportType, filters: Record<string, string>): ReportResult`. Import types from `@domain/entities/report`. *(create, ~3 min)*
- [x] 3.2 [TDD RED] Create `src/__tests__/domain/ReportRepository.contract.test.ts` — write a type-check test that imports `ReportRepository` from `@domain/ports/ReportRepository`. Run `npm test` — FAILED with TS2307 (module not found). *(RED CONFIRMED)*
- [x] 3.3 [TDD GREEN] Port file created — run `npm test`, new test passes. *(GREEN CONFIRMED — 1 suite, 1 test)*
- [x] 3.4 `src/infrastructure/adapters/in-memory/InMemoryReportRepository.ts` — added `implements ReportRepository`; added import for the interface from `@domain/ports/ReportRepository`. *(edit done)*
- [x] 3.5 `src/application/use-cases/ExportReport.ts` — replaced `@infrastructure` import with `ReportRepository` from `@domain/ports/ReportRepository`; updated constructor type. *(edit done)*
- [x] 3.6 `src/application/use-cases/GenerateReport.ts` — same DIP fix. *(edit done)*
- [x] 3.7 `src/application/use-cases/ListReportDefinitions.ts` — same DIP fix. *(edit done)*
- [x] 3.8 Verify `src/infrastructure/http/app.ts` wiring — no change needed. Concrete `InMemoryReportRepository` still passed; TS structural typing satisfied. *(verified)*
- [x] 3.9 Run `rg "from '@infrastructure/" src/application/use-cases/"` → 0 results. *(CONFIRMED)*
- [x] 3.10 Run `npx tsc --noEmit` → 0 errors. *(CONFIRMED)*
- [x] 3.11 Run `npm test` → 322/322 passing (62 suites, +1 contract test). *(CONFIRMED)*
- [x] 3.12 Commit: `refactor(domain): introduce ReportRepository port; remove DIP violation in report use cases` — SHA: b708dc89

---

## Phase 4 — Final Verification

- [x] 4.1 `rg "class InMemory.*Repository" src/infrastructure/adapters/prisma/` → 0 results. *(CONFIRMED)*
- [x] 4.2 `rg "from '@infrastructure/" src/application/"` → 0 results. *(CONFIRMED)*
- [x] 4.3 `fd ReportRepository.ts src/domain/ports/` → file exists. *(CONFIRMED)*
- [x] 4.4 `npx tsc --noEmit` → exit 0, 0 errors. *(CONFIRMED)*
- [x] 4.5 `npm test` → 322 tests / 62 suites — all green. *(CONFIRMED)*

**CHANGE COMPLETE — ready for sdd-verify**

---

## Batch Pause Points Summary

| After Phase | Condition to pause | Status |
|-------------|-------------------|--------|
| Phase 1 | Baselines captured | DONE |
| Phase 2 | Commit 1 pushed, tsc + tests green | DONE — f6585e2a |
| Phase 3 | Commit 2 pushed, tsc + tests green | DONE — b708dc89 |
| Phase 4 | Final verification complete → ready for sdd-verify | DONE |
