# Archive Report: iclass-so-type-mapping

**Change**: iclass-so-type-mapping  
**Date Archived**: 2026-05-28  
**Artifact Store**: hybrid (engram + openspec)  
**Archive Path**: `openspec/changes/archive/2026-05-28-iclass-so-type-mapping/`  

---

## SDD Cycle Complete

The change has been fully planned, implemented, verified, and archived. All phases PASSED. The verify report identified 7 WARNINGs documenting intentional spec deviations (e.g., `thirdPartyId` encapsulated in adapter, `lastSyncedAt` field naming, `{ items: [...] }` response wrapper). All WARNINGs were reconciled by updating the delta specs to reflect the actual shipped implementation. Delta specs have been synced to main specs and the change moved to archive.

---

## Phases Summary

| Phase | Status | Output |
|-------|--------|--------|
| sdd-explore | ✅ PASS | Identified 4 capabilities: new `iclass-so-type-catalog`, modified `iclass-integration`, `projects`, `scheduling` |
| sdd-propose | ✅ PASS | 6-commit strategy; soft-delete catalog; project-driven soType resolution; AD-2 design (adapter owns config) |
| sdd-spec | ✅ PASS | Delta specs for 4 capabilities; REQ schema aligned with implementation |
| sdd-design | ✅ PASS | AD-1 through AD-7 decisions; TDD strategy for ports + use cases + adapters + routes |
| sdd-tasks | ✅ PASS | 130+ tasks across 6 implementation phases + 1 pre-deploy hand-off phase |
| sdd-apply | ✅ PASS | All 130+ tasks completed. 151 test suites / 1154 tests passed (9 skipped). tsc 0 errors. 6 conventional commits. |
| sdd-verify | ✅ PASS | 13/13 spec scenarios compliant. 7 WARNINGs reconciled (spec deviations are intentional, properly documented). |
| sdd-archive | ✅ PASS | Delta specs synced to main specs. Change moved to archive. Artifacts recorded. |

---

## Artifacts Persisted

### Engram (Cross-Session Memory)

Archive report will be saved with topic_key `sdd/iclass-so-type-mapping/archive-report`.

### OpenSpec (Team Artifacts)

Artifacts synchronized to persistent files:

```
openspec/
├── specs/
│   ├── iclass-integration/
│   │   └── spec.md          (MERGED — added REQ-PORT-2, REQ-PORT-3, REQ-CONFIG-2)
│   ├── iclass-so-type-catalog/
│   │   └── spec.md          (NEW — copied from delta spec)
│   ├── projects/
│   │   └── spec.md          (NEW — copied from delta spec)
│   └── scheduling/
│       └── spec.md          (MERGED — added REQ-SCHED-ERR-1 through REQ-SCHED-5)
└── changes/
    └── archive/
        └── 2026-05-28-iclass-so-type-mapping/   (moved from active changes)
            ├── proposal.md
            ├── design.md
            ├── tasks.md
            ├── verify-report.md
            ├── archive-report.md          (this file)
            └── specs/
                ├── iclass-integration/
                │   └── spec.md            (delta spec, synced to main)
                ├── iclass-so-type-catalog/
                │   └── spec.md            (delta spec, synced to main)
                ├── projects/
                │   └── spec.md            (delta spec, synced to main)
                └── scheduling/
                    └── spec.md            (delta spec, synced to main)
```

---

## Specs Synced to Main

| Capability | Action | Details |
|------------|--------|---------|
| iclass-so-type-catalog | CREATED | New capability; spec.md created in openspec/specs/iclass-so-type-catalog/ |
| projects | CREATED | New capability (no prior project spec); spec.md created in openspec/specs/projects/ |
| iclass-integration | MERGED | 3 new REQs added (REQ-PORT-2, REQ-PORT-3, REQ-CONFIG-2) defining soType-per-call pattern |
| scheduling | MERGED | 5 new REQs added (REQ-SCHED-ERR-1 through REQ-SCHED-5) for project-driven soType resolution |

---

## Implementation Summary

All 6 commits in order:

### Commit 1: 2a34f646 — feat(iclass): add IClassSoType domain model, errors and migration scaffold

**Changes**: Schema + domain entity + errors  
**Files**: prisma/schema.prisma, prisma/migrations/, src/domain/entities/iclass-so-type.ts, src/domain/errors/iclass.ts, src/application/util/domainErrorToCode.ts, src/infrastructure/http/middleware/errorHandler.ts  
**Why**: FASE 1 gate — establish domain layer and migration foundation  
**Tests**: npm test: 151 suites / 1154 passed, tsc: 0 errors

### Commit 2: 17c811d9 — feat(iclass): add IClassSoTypeRepository port, extend IClassPort + SchedulingRepository, in-memory adapters

**Changes**: Ports + in-memory test adapters  
**Files**: src/domain/ports/IClassSoTypeRepository.ts, src/domain/ports/IClassPort.ts (extend), src/domain/ports/SchedulingRepository.ts (extend), src/infrastructure/adapters/in-memory/* (new adapters + tests)  
**Why**: FASE 2 gate — TDD RED→GREEN for in-memory adapters; establish port contracts  
**Tests**: npm test green; tsc 0 errors

### Commit 3: f4843b66 — refactor(iclass): reshape IClassSoTypeRepository to per-entry upsertByCode (REQ-CAT-2)

**Changes**: Port interface + adapters refactored for clarity  
**Files**: src/domain/ports/IClassSoTypeRepository.ts (redesigned), src/infrastructure/adapters/in-memory/InMemoryIClassSoTypeRepository.ts (updated), test fixtures  
**Why**: Mid-phase 2 refactor — align port design with implementation; clarify upsertByCode return type  
**Tests**: npm test green; tsc 0 errors

### Commit 4: 17af8e58 — feat(iclass): wire project-driven soType into SendTaskToIClass and add catalog sync use cases

**Changes**: Use cases + SendTaskToIClass modification  
**Files**: src/application/use-cases/SyncIClassSoTypes.ts, ListIClassSoTypes.ts, AssignIClassSoTypeToProject.ts, SendTaskToIClass.ts (modified), project repo extension, test suites  
**Why**: FASE 3 gate — implement use cases; extend SendTaskToIClass with project mapping resolution  
**Tests**: npm test: 151 suites / 1154 passed, tsc: 0 errors

### Commit 5: 58c1c142 — feat(iclass): Prisma catalog adapter, IClassClient listServiceOrderTypes, admin routes for SO type catalog and Project iclassSoTypeId assignment

**Changes**: Prisma adapters + HTTP routes + wiring  
**Files**: src/infrastructure/adapters/iclass/IClassClient.ts (add listServiceOrderTypes), src/infrastructure/adapters/prisma/PrismaIClassSoTypeRepository.ts (new), PrismaSchedulingRepository.ts (extend), PrismaProjectRepository.ts (extend), src/infrastructure/http/routes/iclass-admin.routes.ts (new), app.ts (wiring), projects.routes.ts (extend), test suites  
**Why**: FASE 4 gate — Prisma implementation + HTTP layer + route tests  
**Tests**: npm test green; tsc 0 errors

### Commit 6: 74061770 — feat(iclass)!: remove ICLASS_DEFAULT_SO_TYPE; soType is now per-task from project mapping

**Changes**: Config cleanup; removal of defaultSoType  
**Files**: src/infrastructure/adapters/iclass/IClassClient.ts (remove field), src/infrastructure/http/iclass.factory.ts (remove arg), src/infrastructure/config.ts (remove var), env.example, .github/workflows/deploy.yml, docs/iclass-integration.md, test cleanup  
**Why**: FASE 5 gate — enforce fail-fast; TypeScript prevents forgotten soType by making it required  
**Tests**: npm test green; tsc 0 errors (rejects any constructor call without soType)

---

## Verification Results

| Category | Status | Details |
|----------|--------|---------|
| **Build** | ✅ PASS | tsc --noEmit: 0 errors (after all 6 commits) |
| **Tests** | ✅ PASS | npm test: 151 suites / 1154 tests, 9 skipped (all green) |
| **Specs** | ⚠️ 7 WARNINGS (RECONCILED) | See next section |
| **Commits** | ✅ PASS | Conventional format, no Co-Authored-By attribution |
| **Invariants** | ✅ PASS | Hexagonal DIP enforced; no infrastructure imports in application/domain |
| **Regression** | ✅ PASS | All existing SendTaskToIClass tests pass; new tests added for soType resolution |

### WARNING Reconciliation

The verify report identified 7 WARNINGs — all documenting intentional deviations from the delta spec where the **implementation is correct and the spec needed updating**. All WARNINGs have been reconciled:

| W | Issue | Root Cause | Resolution |
|----|-------|-----------|-----------|
| W-1 | Entity missing `thirdPartyId` field, `lastSyncedAt` not `syncedAt` | AD-2: thirdPartyId encapsulated in adapter; field naming in implementation | Updated REQ-CAT-1 to reflect actual entity shape without thirdPartyId; field name is `lastSyncedAt` |
| W-2 | `listServiceOrderTypes()` has no `thirdPartyId` parameter | AD-2: adapter owns config, not per-call | Updated REQ-PORT-3 to show no-arg signature; thirdPartyId from constructor |
| W-3 | `GET /api/admin/iclass/so-types` returns `{ items: [...] }` wrapper | Batch C decision; tested wrapper in all route tests | Updated REQ-HTTP-LIST-1 to document wrapper shape |
| W-4 | REQ-SHAPE-CAT-1 does not verify `thirdPartyId` field | Field doesn't exist (W-1) | Updated REQ-SHAPE-CAT-1 to remove thirdPartyId; field list matches implementation |
| W-5 | `markInactiveExcept` drops `thirdPartyId`, returns `number` not `void` | Single-thirdParty catalog (AD-2); return type more useful | Updated REQ-CAT-2 signature: `Promise<number>` return; no thirdPartyId param |
| W-6 | `SyncResult` returns superset of `{ synced, deactivated }` | Implementation returns `{ synced, created, updated, reactivated, deactivated }` | Updated REQ-SYNC-1 and REQ-HTTP-SYNC-1 to allow superset; minimum fields documented |
| W-7 | tasks.md V.* checklist items unticked | These are operator gate checks (pre-deploy), not code tasks | Documented in verify-report; not a spec reconciliation (they're in tasks.md, not spec) |

All WARNINGs reconciled. No CRITICAL issues. Delta specs now match implementation exactly.

---

## Operator Pre-Deploy Checklist

From verify-report.md (remaining action items for prod rollout):

- [ ] **Remove secrets**: Delete `ICLASS_DEFAULT_SO_TYPE` from GitHub Actions Settings → Secrets
- [ ] **Remove env var**: Delete `ICLASS_DEFAULT_SO_TYPE` from EasyPanel service config
- [ ] **Post-deploy sync**: Call `POST /api/admin/iclass/so-types/sync` — expect `{ synced: ~26, deactivated: 0, ... }`
- [ ] **Post-sync catalog**: Call `GET /api/admin/iclass/so-types?active=true` and note the `id` values for each type
- [ ] **Map projects**: For each active Project that uses "Enviar a IClass", call `PATCH /api/projects/:id { iclassSoTypeId: "<id>" }` with the correct type
- [ ] **Verify mapping**: Call `GET /api/projects` and confirm no active IClass-using Project has `iclassSoType: null`
- [ ] **Enable feature flag**: `PATCH /api/admin/feature-flags/iclass-integration { "enabled": true }`
- [ ] **Smoke test**: Move a test task to "Enviar a IClass" and confirm `iclassOrderCode` is populated

**Important**: The feature flag `iclass-integration` MUST remain OFF until projects are mapped. If flag is ON before mapping completes, all "Send to IClass" operations will fail with `MISSING_ICLASS_MAPPING`.

---

## What's Next

This change closes the **project-driven SO type mapping** scope. The implementation is production-ready pending the operator checklist. Future work:

1. **Auto-sync cron** (out of scope for this change — was explicitly listed as Future Work in proposal).
2. **UI for Project mapping** (out of scope — FE team implements the dropdown and mapping page).
3. **Backfill script** (optional — document if teams want to bulk-assign mappings).

---

## Audit Trail

**Git Commits** (Local):
- 2a34f646 — feat(iclass): add IClassSoType domain model, errors and migration scaffold
- 17c811d9 — feat(iclass): add IClassSoTypeRepository port, extend IClassPort + SchedulingRepository, in-memory adapters
- f4843b66 — refactor(iclass): reshape IClassSoTypeRepository to per-entry upsertByCode (REQ-CAT-2)
- 17af8e58 — feat(iclass): wire project-driven soType into SendTaskToIClass and add catalog sync use cases
- 58c1c142 — feat(iclass): Prisma catalog adapter, IClassClient listServiceOrderTypes, admin routes for SO type catalog and Project iclassSoTypeId assignment
- 74061770 — feat(iclass)!: remove ICLASS_DEFAULT_SO_TYPE; soType is now per-task from project mapping

**File Paths** (OpenSpec):
- `openspec/specs/iclass-so-type-catalog/spec.md` — new main spec
- `openspec/specs/projects/spec.md` — new main spec
- `openspec/specs/iclass-integration/spec.md` — merged (3 new REQs)
- `openspec/specs/scheduling/spec.md` — merged (5 new REQs)
- `openspec/changes/archive/2026-05-28-iclass-so-type-mapping/` — complete artifact trail

**Status**: Ready for team review, merge to main branch, and deployment.

---

## Rollback Plan

The FK is nullable and the catalog is aditiva. To rollback:

1. Revert the 6 commits to the previous code (uses `ICLASS_DEFAULT_SO_TYPE`).
2. Restore `ICLASS_DEFAULT_SO_TYPE` in deploy workflow and GitHub Secrets.
3. The new columns (`Project.iclassSoTypeId`, `IClassSoType` table) remain in DB (no effect on old code).
4. Optionally clean up via `prisma migrate resolve` if full cleanup desired.

While the catalog is empty or Projects unmapped, all "Send to IClass" calls will fail — this is deliberate (fail-fast). The flag default OFF protects the rollout.
