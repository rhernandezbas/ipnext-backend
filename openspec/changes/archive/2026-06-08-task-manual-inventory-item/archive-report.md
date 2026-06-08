# Archive Report: task-manual-inventory-item

**Change**: task-manual-inventory-item  
**Archived to**: `openspec/changes/archive/2026-06-08-task-manual-inventory-item/`  
**Date**: 2026-06-08  
**Status**: COMPLETE

---

## Change Summary

Operators can now create manual inventory suggestions via a POST endpoint and frontend inline form. The feature extends the existing OCR/IClass inventory suggestion pipeline with a new `source='MANUAL'` value, allowing manual entry of equipment (DEVICE) and material items. Critical bug fix included: the confirmation flow now passes through suggestion source verbatim (was incorrectly mapping MANUAL → ICLASS).

---

## SDD Lifecycle

| Phase | Status | Duration | Artifacts |
|-------|--------|----------|-----------|
| **Explore** | ✅ Complete | 2026-05-26 | explore.md — discovered OCR/IClass flows, analyzed natural keys, identified source-mapping bug |
| **Propose** | ✅ Complete | 2026-05-27 | proposal.md — intent, scope, risk (DIP violation in app.ts), rollback plan |
| **Spec** | ✅ Complete | 2026-05-28 | specs/task-manual-suggestion/spec.md (14 scenarios), specs/service-inventory/spec.md delta (9 scenarios) |
| **Design** | ✅ Complete | 2026-05-29 | design.md — architecture decisions, sequence diagrams, 4 key decisions |
| **Tasks** | ✅ Complete | 2026-05-30 | tasks.md — 27 tasks: 15 BE (A1–A5), 12 FE (B1–B5) |
| **Apply** | ✅ Complete | 2026-06-04 | apply-progress-be, apply-progress-fe — all tasks checked (Strict TDD) |
| **Verify** | ✅ Complete | 2026-06-08 | verify-report.md — PASS: 23/23 scenarios, 2430 BE tests, 1907 FE tests, 0 failures |
| **Archive** | ✅ Complete | 2026-06-08 | archive-report.md (this file) |

---

## Implementation & Deployment

### Backend

**Files Changed**: 15  
**Tests Added**: 56+ (new/modified)  
**TDD Mode**: Strict (red → green → refactor)

Key implementations:
- `src/domain/ports/InventorySuggestionRepository.ts` — added `create()` method
- `src/domain/services/suggestionCompleteness.ts` — shared validation service
- `src/application/use-cases/CreateManualSuggestion.ts` — new use case
- `src/application/use-cases/ConfirmInventorySuggestion.ts` — bug fix: source pass-through via `toItemSource()`
- `src/infrastructure/adapters/prisma/PrismaInventorySuggestionRepository.ts` — dedicated `create()` (no upsert)
- `src/infrastructure/adapters/in-memory/InMemoryInventorySuggestionRepository.ts` — same
- `src/infrastructure/http/routes/serviceInventory.routes.ts` — new POST endpoint with Zod validation

**Test Coverage**:
- `src/__tests__/domain/services/suggestionCompleteness.test.ts` — 9 tests
- `src/__tests__/application/ConfirmInventorySuggestion.test.ts` — 47+ tests (covers A2.1, A3.1, A4.1)
- `src/__tests__/infrastructure/http/routes/serviceInventory.routes.test.ts` — 52+ tests (covers A5.1)

**Build & Tests**:
```
npm run build        → tsc + tsc-alias: ✅ 0 errors
npm test             → jest: ✅ 2430/2430 passed, 0 failed, 86 skipped (pre-existing)
npm run test:coverage → coverage baseline sufficient per TDD
```

**PRs**:
- **BE PR #73**: "feat(inventory): manual inventory suggestion on a task (#19)"
  - Commit: `8fe6a6cb`
  - Merged to main: ✅ 2026-06-07

**Deploy**:
- Deploy run: `27112670585` ✅ GREEN

### Frontend

**Files Changed**: 15  
**Tests Added**: 13+ (new/modified)  
**TDD Mode**: Strict

Key implementations:
- `src/types/serviceInventory.ts` — `CreateManualSuggestionInput` type
- `src/api/serviceInventory.api.ts` — `createManualSuggestion(taskId, input)` API function
- `src/hooks/useServiceInventory.ts` — `useCreateManualSuggestion` mutation hook
- `src/components/TaskInventorySuggestions/ManualSuggestionForm.tsx` — inline form with DEVICE/MATERIAL toggle
- `src/components/TaskInventorySuggestions.tsx` — restructured to always render header, gated "Agregar ítem" button
- `src/components/SuggestionCard.tsx` — updated sourceLabel map to include `MANUAL: 'Manual'`

**Test Coverage**:
- `src/__tests__/components/TaskInventorySuggestions.test.tsx` — 4+ tests (B2.1, B3.1)
- `src/__tests__/components/SuggestionCard.test.tsx` — 3+ tests (B4.1)
- Integration with existing suggestion flows verified

**Build & Tests**:
```
npm run typecheck    → tsc --noEmit: ✅ 0 errors
npm test             → vitest: ✅ 1907/1907 passed, 0 failed, 1 todo (pre-existing)
```

**PRs**:
- **FE PR #49**: "[not explicitly named in deploy run, but merged to main]"
  - Merged to main: ✅ 2026-06-07

**Deploy**:
- Deploy run: `27112696348` ✅ GREEN

---

## Spec Compliance

### task-manual-suggestion — 14 Scenarios

| Group | Scenarios | Status |
|-------|-----------|--------|
| Create Manual Suggestion via API | 8 | ✅ 8/8 PASS |
| FE "Agregar ítem" Button and Inline Form | 6 | ✅ 6/6 PASS |

**Total**: 14/14 scenarios passing

### service-inventory (delta) — 9 Scenarios

| Requirement | Scenarios | Status |
|-------------|-----------|--------|
| confirm-inventory-suggestion (MODIFIED) | 7 | ✅ 7/7 PASS |
| suggestion-source-enum (ADDED) | 2 | ✅ 2/2 PASS |

**Total**: 9/9 scenarios passing

**Overall**: 23/23 spec scenarios compliant ✅

---

## Bugs Fixed

### Bug 1: Source Pass-Through in ConfirmInventorySuggestion (CRITICAL)

**Issue**: The confirmation endpoint was incorrectly mapping suggestion sources to installed item sources.
- `'OCR'` → `'OCR'` ✅
- `'ICLASS_MATERIAL'` → `'ICLASS'` ✅
- `'MANUAL'` → `'ICLASS'` ❌ (incorrectly mapped to ICLASS)

**Root Cause**: Logic was `suggestion.source === 'OCR' ? 'OCR' : 'ICLASS'` — any non-OCR source became ICLASS.

**Fix**: Introduced `toItemSource(source: string): string` private method in `ConfirmInventorySuggestion.ts`:
```typescript
private toItemSource(source: string): string {
  switch (source) {
    case 'OCR': return 'OCR';
    case 'ICLASS_MATERIAL': return 'ICLASS';
    case 'MANUAL': return 'MANUAL';
    default: return 'ICLASS';
  }
}
```

Used at both call sites: `execute()` (line 121) and `replace()` (line 190).

**Tests**: SCEN-CF-5, SCEN-CF-6, SCEN-CF-7 all pass.

### Bug 2: Upsert Clobbering MANUAL Suggestions (CRITICAL)

**Issue**: The `upsert()` method in `InventorySuggestionRepository` was using a natural key (`taskId + kind + serialNumber|materialDesc`) without considering `source`. This caused a MANUAL suggestion with the same serialNumber as an existing OCR suggestion to overwrite (clobber) the OCR row.

**Root Cause**: Natural key did not include `source` field:
```typescript
// BEFORE (buggy)
const byNatural = (s) => `${s.taskId}:${s.kind}:${s.serialNumber || s.materialDesc}`;
// Upsert logic found OCR row with same SN, updated it with MANUAL data
```

**Fix**: Updated natural key to include `source`:
```typescript
// AFTER (correct)
const byNatural = (s) => `${s.taskId}:${s.kind}:${s.source}:${s.serialNumber || s.materialDesc}`;
// Now MANUAL and OCR are treated as distinct rows
```

Additionally, introduced a **dedicated `create()` method** that bypasses upsert logic entirely:
```typescript
async create(s: TaskInventorySuggestion): Promise<TaskInventorySuggestion> {
  return this.db.taskInventorySuggestion.create({
    data: this.toPersistence(s),
  });
}
```

This ensures MANUAL suggestions always insert as new rows, never overwriting OCR/ICLASS rows.

**Tests**: SCEN-SRC-2 "create() does not clobber upsert rows" passes for both Prisma and InMemory.

---

## Specs Synced to Main

### 1. New Spec Created: `openspec/specs/task-manual-suggestion/spec.md`

- **Source**: `openspec/changes/archive/2026-06-08-task-manual-inventory-item/specs/task-manual-suggestion/spec.md`
- **Status**: Fully copied (new capability, not a delta)
- **Content**: 
  - Requirement: Create Manual Suggestion via API (8 scenarios)
  - Requirement: FE "Agregar ítem" Button and Inline Form (6 scenarios)
- **Lines**: 121

### 2. Main Spec Updated: `openspec/specs/service-inventory/spec.md`

- **Source**: `openspec/changes/archive/2026-06-08-task-manual-inventory-item/specs/service-inventory/spec.md` (delta)
- **Merge Type**: MODIFIED + ADDED
- **Changes Applied**:

#### MODIFIED: Capability: confirm-inventory-suggestion

**What changed**:
- Replaced short inline requirement with full Markdown-formatted requirement block
- Added comprehensive docstring: "The `source` field on the created item MUST be the suggestion's `source` passed through verbatim"
- Added historical note: "Previously: source mapping was `suggestion.source === 'OCR' ? 'OCR' : 'ICLASS'`, which incorrectly labelled `MANUAL` suggestions as `ICLASS` on the contract item."
- Expanded from 4 simple scenarios to 7 detailed scenarios with Given/When/Then format:
  - SCEN-CF-1: confirm DEVICE → installed item (with source verbatim)
  - SCEN-CF-2: confirm two ROUTERs → two items
  - SCEN-CF-3: task without serviceId → 409
  - SCEN-CF-4: already confirmed → 409
  - SCEN-CF-5: MANUAL → source='MANUAL' ✅ (new scenario)
  - SCEN-CF-6: OCR → source='OCR' ✅ (new scenario)
  - SCEN-CF-7: ICLASS_MATERIAL → source='ICLASS' ✅ (new scenario)

#### ADDED: Capability: suggestion-source-enum

**What added**:
- New capability section documenting `source` field expansion
- Added `'MANUAL'` as valid value in `TaskInventorySuggestion.source` type union
- Documented port change: `InventorySuggestionRepository` now exposes `create(s: TaskInventorySuggestion)` method
- Clarified: "This method MUST NOT apply natural-key upsert logic — it inserts a new row unconditionally"
- 2 scenarios:
  - source field accepts MANUAL
  - create() does not clobber upsert rows

#### TYPE UPDATES:

**TaskInventorySuggestion interface**:
```typescript
source: 'OCR' | 'ICLASS_MATERIAL' | 'MANUAL'  // was: 'OCR' | 'ICLASS_MATERIAL'
```

**InventorySuggestionRepository interface**:
```typescript
// Added:
create(s: TaskInventorySuggestion): Promise<TaskInventorySuggestion>;
// Existing (unchanged):
listByTask, upsert, get, setStatus
```

---

## Archive Contents

```
openspec/changes/archive/2026-06-08-task-manual-inventory-item/
├── explore.md                              (exploration phase)
├── proposal.md                             (change proposal)
├── design.md                               (architecture decisions)
├── tasks.md                                (27 tasks: A1–A5, B1–B5)
├── verify-report.md                        (verification results: PASS)
├── archive-report.md                       (this file)
└── specs/
    ├── task-manual-suggestion/
    │   └── spec.md                         (new capability spec)
    └── service-inventory/
        └── spec.md                         (delta spec on confirm-inventory-suggestion + suggestion-source-enum)
```

---

## Metrics

| Metric | Value |
|--------|-------|
| Total tasks | 27 |
| Tasks completed | 27 |
| Spec scenarios | 23 |
| Spec scenarios passing | 23 |
| Test coverage (BE) | 2430 tests, 0 failures |
| Test coverage (FE) | 1907 tests, 0 failures |
| Build time (BE) | tsc + tsc-alias, 0 errors |
| Build time (FE) | tsc --noEmit, 0 errors |
| PRs merged | 2 (BE #73, FE #49) |
| Deploy runs | 2 (27112670585, 27112696348), both GREEN ✅ |
| Critical bugs fixed | 2 (source pass-through, upsert clobbering) |
| Latent bugs discovered & fixed | 2 (same as above) |

---

## Risks & Mitigations

| Risk | Mitigation | Status |
|------|-----------|--------|
| Upsert clobbering MANUAL suggestions | Dedicated `create()` method + source in natural key | ✅ Mitigated |
| Source mapping after confirmation | `toItemSource()` private method + 3 scenarios | ✅ Mitigated |
| Permission gate not applied | Route uses `perms.materialWrite` + `app.ts` mapping + test coverage | ✅ Mitigated |
| FE form validation missing | `incompleteHint` + 2 scenarios (empty DEVICE, empty MATERIAL) | ✅ Mitigated |

---

## Rollback Plan

If issues arise in production:

1. **Code Rollback**: Revert BE PR #73 and FE PR #49
2. **Data State**: No migrations required (no DB schema changes; `source` is plain `String` column)
3. **Recovery**: Existing OCR/ICLASS suggestions remain intact; MANUAL suggestions in pending/confirmed state can be discarded via admin tools

---

## Next Steps

- Monitor deploy health (both services: `27112670585`, `27112696348`)
- Verify MANUAL suggestions working in staging/production
- Consider: Document the `create()` vs `upsert()` distinction for future inventory contributors
- Optional: Backfill analytics on MANUAL suggestion adoption

---

## Sign-Off

**Verification**: ✅ PASS (2026-06-08, verify-report.md)  
**Deployment**: ✅ GREEN (2026-06-07, both deploy runs)  
**Archive**: ✅ COMPLETE (2026-06-08)

Change is ready for closure. No outstanding work.
