# Verification Report

**Change**: task-manual-inventory-item
**Version**: specs/task-manual-suggestion + specs/service-inventory (delta)
**Mode**: Strict TDD
**Date**: 2026-06-08

---

## Completeness

| Metric | Value |
|--------|-------|
| Tasks total | 27 |
| Tasks complete | 27 |
| Tasks incomplete | 0 |

All 27 tasks checked in `tasks.md`. Batch A (15 BE tasks A1.1–A5.4) and Batch B (12 FE tasks B1.1–B5.1) are fully checked.

---

## Build & Tests Execution

### Backend

**Build / Typecheck**: ✅ Passed  
`npx tsc --noEmit` — exit 0, no output, no errors.

**Tests**: ✅ 2430 passed / 0 failed / 86 skipped (unrelated pre-existing)  
Full suite: `npx jest --runInBand` — 315 suites passed (6 skipped), 2430 tests passed, 0 failed.

Targeted suites relevant to this change:
- `suggestionCompleteness.test.ts` — 9/9 passed
- `ServiceInventory.test.ts` — 47+/47+ passed (includes A2.1, A3.1, A4.1 blocks)
- `serviceInventory.routes.test.ts` — 52+/52+ passed (includes A5.1 block)

**Coverage**: Not run separately (full suite baseline sufficient per TDD evidence).

### Frontend

**Typecheck**: ✅ Passed  
`npm run typecheck` (`tsc --noEmit`) — exit 0, no errors.

**Tests**: ✅ 1907 passed / 0 failed / 1 todo  
Full suite: `npx vitest run` — 229 files, 1907 tests passed, 0 failed, 1 todo (pre-existing, unrelated).

---

## TDD Compliance

| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | ✅ | Found in both apply-progress-be and apply-progress-fe |
| All tasks have tests | ✅ | Every A/B phase task has a mapped test file |
| RED confirmed (tests exist) | ✅ | 5/5 BE test files verified present; FE test files present |
| GREEN confirmed (tests pass) | ✅ | All test files pass on execution (2430 BE + 1907 FE) |
| Triangulation adequate | ✅ | Multiple cases per behavior: A1.1 9 cases, A4.1 6 cases, A5.1 7 cases, B2.1 4 cases, B3.1 3 cases |
| Safety Net for modified files | ✅ | All modified files had safety nets: 36/36 before A2; 38/38 before A3; 45/45 before A5; 15/15 before B4 |

**TDD Compliance**: 6/6 checks passed

---

## Test Layer Distribution

| Layer | Tests | Files | Tools |
|-------|-------|-------|-------|
| Unit (BE) | 9+47 = 56+ | 2 | Jest + in-memory repos |
| Integration (BE) | 7+ | 1 | Jest + supertest |
| Integration (FE) | 13+ | 2 | Vitest + @testing-library/react |
| **Total new/modified** | **76+** | **5** | |

---

## Spec Compliance Matrix

### Spec: task-manual-suggestion — "Create Manual Suggestion via API" (8 scenarios)

| Scenario | Test File | Test Name | Result |
|----------|-----------|-----------|--------|
| DEVICE suggestion — serial number only | `ServiceInventory.test.ts` + `serviceInventory.routes.test.ts` | "DEVICE solo SN → sugerencia MANUAL pending guardada" + "POST 201 DEVICE con SN" | ✅ COMPLIANT |
| DEVICE suggestion — MAC only | `ServiceInventory.test.ts` | "DEVICE solo MAC → sugerencia MANUAL pending guardada" | ✅ COMPLIANT |
| MATERIAL suggestion — happy path | `ServiceInventory.test.ts` + `serviceInventory.routes.test.ts` | "MATERIAL happy path" + "POST 201 MATERIAL con descripción" | ✅ COMPLIANT |
| DEVICE incomplete — no SN or MAC | `ServiceInventory.test.ts` + `serviceInventory.routes.test.ts` | "DEVICE sin SN ni MAC → lanza IncompleteSuggestionError" + "POST 422 SUGGESTION_INCOMPLETE" | ✅ COMPLIANT |
| MATERIAL incomplete — empty description | `suggestionCompleteness.test.ts` | "MATERIAL con descripción vacía → lanza IncompleteSuggestionError" (+ null + spaces) | ✅ COMPLIANT |
| Forbidden — missing permission | `serviceInventory.routes.test.ts` | "POST 403 sin permiso materialWrite" | ✅ COMPLIANT |
| Task not found | `ServiceInventory.test.ts` + `serviceInventory.routes.test.ts` | "task no encontrada → lanza TaskNotFoundError" + "POST 404 task no encontrada" | ✅ COMPLIANT |
| MANUAL does not clobber OCR suggestion | `ServiceInventory.test.ts` | "create(MANUAL, SN-1) no clobber upsert OCR: ambas filas coexisten y el OCR conserva photoUrl" | ✅ COMPLIANT |

### Spec: task-manual-suggestion — "FE Agregar ítem Button and Inline Form" (6 scenarios)

| Scenario | Test File | Test Name | Result |
|----------|-----------|-----------|--------|
| Button visible in empty state | `TaskInventorySuggestions.test.tsx` | "button visible in empty state with inventory.write" | ✅ COMPLIANT |
| Button visible in non-empty state | `TaskInventorySuggestions.test.tsx` | "button visible in non-empty state with inventory.write" | ✅ COMPLIANT |
| Button hidden without permission | `TaskInventorySuggestions.test.tsx` | "button NOT rendered without inventory.write" | ✅ COMPLIANT |
| Form — incompleteHint on DEVICE submit without SN/MAC | `TaskInventorySuggestions.test.tsx` | "submit DEVICE with no SN/MAC shows incompleteHint, no API call" | ✅ COMPLIANT |
| Form — successful DEVICE submission | `TaskInventorySuggestions.test.tsx` | "successful DEVICE submit calls mutation + collapses form" | ✅ COMPLIANT |
| MANUAL sourceLabel on SuggestionCard | `SuggestionCard.test.tsx` | "suggestion source='MANUAL' → badge text 'Manual'" | ✅ COMPLIANT |

### Spec: service-inventory (delta) — "confirm-inventory-suggestion" (7 scenarios)

| Scenario | Test File | Test Name | Result |
|----------|-----------|-----------|--------|
| SCEN-CF-1 — confirm DEVICE → installed item with source verbatim | `ServiceInventory.test.ts` | "SCEN-CF-1: confirms a DEVICE suggestion → one ContractInstalledItem on the contract" | ✅ COMPLIANT |
| SCEN-CF-2 — confirm two ROUTERs → two items | `ServiceInventory.test.ts` | "SCEN-CF-2: two routers confirmed → two rows" | ✅ COMPLIANT |
| SCEN-CF-3 — task without serviceId → 409 | `ServiceInventory.test.ts` | "SCEN-CF-3: task without contract → TASK_HAS_NO_CONTRACT" | ✅ COMPLIANT |
| SCEN-CF-4 — already confirmed → 409 | `ServiceInventory.test.ts` | "SCEN-CF-4: confirming an already-confirmed suggestion → SUGGESTION_ALREADY_CONFIRMED" | ✅ COMPLIANT |
| SCEN-CF-5 — MANUAL suggestion confirmed → source preserved | `ServiceInventory.test.ts` | "SCEN-CF-5: sugerencia MANUAL confirmada → ContractInstalledItem.source = MANUAL" | ✅ COMPLIANT |
| SCEN-CF-6 — OCR suggestion confirmed → source OCR | `ServiceInventory.test.ts` | "SCEN-CF-6: sugerencia OCR confirmada → ContractInstalledItem.source = OCR" | ✅ COMPLIANT |
| SCEN-CF-7 — ICLASS_MATERIAL suggestion confirmed → source ICLASS | `ServiceInventory.test.ts` | "SCEN-CF-7: sugerencia ICLASS_MATERIAL confirmada → ContractInstalledItem.source = ICLASS" | ✅ COMPLIANT |

### Spec: service-inventory (delta) — "suggestion-source-enum" (2 scenarios)

| Scenario | Test File | Test Name | Result |
|----------|-----------|-----------|--------|
| source field accepts MANUAL | `ServiceInventory.test.ts` | "create(MANUAL, SN-1) no clobber upsert OCR: ambas filas coexisten" (MANUAL row stored with source='MANUAL') | ✅ COMPLIANT |
| create() does not clobber upsert rows | `ServiceInventory.test.ts` | "create(MANUAL, SN-1) no clobber upsert OCR: ambas filas coexisten y el OCR conserva photoUrl" + "create(MANUAL) agrega segunda fila para la misma clave natural" | ✅ COMPLIANT |

**Compliance summary: 23/23 scenarios compliant**

---

## Correctness (Static — Structural Evidence)

| Requirement | Status | Notes |
|-------------|--------|-------|
| `InventorySuggestionRepository.create()` port | ✅ Implemented | `src/domain/ports/InventorySuggestionRepository.ts` exposes `create()` |
| `assertSuggestionComplete` shared domain service | ✅ Implemented | `src/domain/services/suggestionCompleteness.ts` — messages byte-identical per design |
| `CreateManualSuggestion` use case | ✅ Implemented | `src/application/use-cases/CreateManualSuggestion.ts` — no `@infrastructure` imports |
| `toItemSource` in both `execute()` and `replace()` | ✅ Implemented | Lines 121 and 190 in `ConfirmInventorySuggestion.ts` both use `this.toItemSource()` |
| `source` in upsert natural key — Prisma | ✅ Implemented | `findFirst WHERE` includes `source: s.source` (line 43 of PrismaInventorySuggestionRepository) |
| `source` in upsert natural key — InMemory | ✅ Implemented | `naturalKey()` includes `s.source` (line 10) |
| `create()` in InMemory — no byNatural registration | ✅ Implemented | Comment + code confirms intentional omission of `byNatural` registration |
| Prisma schema `source` comment updated | ✅ Implemented | Comment documents `OCR \| ICLASS_MATERIAL \| MANUAL` |
| `InvalidItemTypeError` in domain errors | ✅ Implemented | Used in `CreateManualSuggestion.ts` via `@domain/errors/inventory` |
| POST route guard (`inventory.write`) | ✅ Implemented | Route uses `perms.materialWrite`; `app.ts` maps `materialWrite: requirePerm('inventory', 'write')` |
| `CreateManualSuggestionInput` FE type | ✅ Implemented | `src/types/serviceInventory.ts` |
| `createManualSuggestion` API fn | ✅ Implemented | `src/api/serviceInventory.api.ts` |
| `useCreateManualSuggestion` hook | ✅ Implemented | `src/hooks/useServiceInventory.ts` — mutation with `onSuccess` invalidating `suggestionsKey(taskId)` |
| `ManualSuggestionForm.tsx` component | ✅ Implemented | DEVICE/MATERIAL toggle, incompleteHint, collapses on success |
| `TaskInventorySuggestions` panel restructure | ✅ Implemented | Dropped early return; always renders header with `useCan('inventory.write')` gated button |
| `SuggestionCard` MANUAL sourceLabel | ✅ Implemented | `'MANUAL': 'Manual'` in sourceLabel map |

---

## Coherence (Design)

| Decision | Followed? | Notes |
|----------|-----------|-------|
| Decision 1: dedicated `create()`, source in upsert natural key | ✅ Yes | Both Prisma and InMemory adapters implement exactly as designed |
| Decision 2: `assertSuggestionComplete` domain service | ✅ Yes | Lives in `domain/services/`, exact messages, used by both use cases |
| Decision 3: `toItemSource` in both `execute()` and `replace()` | ✅ Yes | Private helper used at both call sites |
| Decision 4: Route + DTO contract | ✅ Yes | POST route with Zod schema, 201/400/403/404/422 responses, enriched DTO |
| Decision 5: FE inline form, `useCan` gate, `useCreateManualSuggestion` | ⚠️ Deviated | Design specifies `<Can permission="inventory.write">` wrapper; implemented via `useCan('inventory.write')` direct hook. Functionally equivalent — both use `useMyPermissions` internally. Deviation is intentional and acceptable (matches existing panel pattern). |
| `DeviceTypeCatalogService` as 4th constructor param | ⚠️ Deviated | Design shows `CreateManualSuggestion(suggestions, scheduling, inventory)` — 3 params. Implementation has 4 params adding `deviceTypes: DeviceTypeCatalogService`. Necessary for type validation; design omitted this dependency. Acceptable — behavior aligns with spec requirement for `INVALID_ITEM_TYPE`. |
| `InvalidItemTypeError` in domain errors | ⚠️ Deviated | Design mentions inline 422 in route; implemented as a proper domain error. Improvement: domain owns the error, errorHandler maps it to 422. |
| Hook invalidation verified at hook level, not render level | ⚠️ Deviated | B1.3 test verifies mutation call and correct taskId rather than QueryClient cache state. Documented in apply-progress-fe as pragmatic: testing QueryClient invalidation at render level requires a real server mock. Acceptable — the onSuccess code path is exercised in the implementation. |

---

## Assertion Quality

No trivial assertions found. All assertions in the examined test files verify real behavior:
- `suggestionCompleteness.test.ts`: 9 tests with concrete throw/not-throw assertions, distinct messages verified
- `ServiceInventory.test.ts` (A2.1/A3.1/A4.1 blocks): each test checks concrete field values (source, status, serialNumber, etc.)
- `serviceInventory.routes.test.ts` (A5.1 block): HTTP status + response body code/field assertions
- `TaskInventorySuggestions.test.tsx`: DOM presence/absence, mutation call args, form collapse verified
- `SuggestionCard.test.tsx`: badge text exact value verified; triangulated with OCR case

**Assertion quality**: ✅ All assertions verify real behavior

---

## Issues Found

**CRITICAL** (must fix before archive):
None

**WARNING** (should fix):
None

**SUGGESTION** (nice to have):
- S1: The design spec for `CreateManualSuggestion` constructor signature (3 params) does not match the implementation (4 params with `DeviceTypeCatalogService`). Consider updating `design.md` to reflect the actual signature — not a code issue, purely documentation drift.

---

## Verdict

**PASS**

All 23 spec scenarios are covered by passing tests. Both test suites (BE: 2430/2430, FE: 1907/1907) are green. Both typechecks clean. 27/27 tasks complete. 4 documented deviations are all acceptable: `<Can>` vs `useCan` (functionally equivalent), `DeviceTypeCatalogService` 4th param (necessary addition design omitted), `InvalidItemTypeError` as domain error (improvement), and hook-level invalidation test (pragmatic). No critical issues.
