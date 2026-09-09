# Apply Progress: WhatsApp Template CTA Button

**Status**: all 13 tasks complete (5/5 phases). Ready for `sdd-verify`.
**Mode**: Strict TDD.
**Commit**: `32adcf47` on branch `feat/whatsapp-template-buttons` (local only, NOT pushed).

## Completed Tasks

- [x] 1.1 `TemplateMessagingPort.ts` — `TemplateButton` interface + `button?` on `CreateTemplateInput`.
- [x] 1.2 `messaging-templates.dto.ts` — `button?` on HTTP `CreateTemplateInput`.
- [x] 1.3 `InMemoryTemplateMessagingGateway.ts` — `button?` on `TemplateCreateCallRecord`, recorded in `createCalls`.
- [x] 2.1 RED — `CreateTemplate.test.ts`: 8 new cases (valid button, no-button regression, whitespace title, >25 char title, relative url, ftp:// url, missing title key, missing url key, `{{1}}` placeholder pass-through).
- [x] 2.2 GREEN — `CreateTemplate.ts`: module-private `assertValidButton()`; raw url stored (never `.href`).
- [x] 3.1 RED — `TwilioContentGateway.admin.test.ts`: 4 new cases (no-button byte-identical, with-button `twilio/call-to-action`, `{{1}}` unencoded).
- [x] 3.2 GREEN — `TwilioContentGateway.ts` `createTemplate()`: `types` branch on `input.button`.
- [x] 4.1 RED — `templates.routes.test.ts`: 2 new cases (valid button → 201 + createCalls populated; invalid button → 400).
- [x] 4.2 GREEN — `templates.routes.ts`: type-guarded `button` forwarded into `CreateTemplateInput`.
- [x] 4.3 RED — `external-messaging-templates.routes.test.ts`: 2 new cases proving the prior Zod schema stripped `button` (both failed pre-fix).
- [x] 4.4 GREEN — `external-messaging.routes.ts`: `CreateTemplateBodySchema` extended with `button: z.object({title,url}).optional()`.
- [x] 5.1 Full targeted suite green (see Test Summary).
- [x] 5.2 VAL-3 preview tests unchanged, still passing — no code touched, spot-checked in full suite run.

## Files Changed

| File | Action | What Was Done |
|------|--------|---------------|
| `src/domain/ports/TemplateMessagingPort.ts` | Modified | Added `TemplateButton` + `button?` on `CreateTemplateInput` |
| `src/application/dto/messaging-templates.dto.ts` | Modified | Added `button?` on HTTP `CreateTemplateInput` |
| `src/application/use-cases/messaging/CreateTemplate.ts` | Modified | Added `assertValidButton()` + wired into `execute()` |
| `src/infrastructure/adapters/in-memory/InMemoryTemplateMessagingGateway.ts` | Modified | `TemplateCreateCallRecord.button` + recorded in `createTemplate()` |
| `src/infrastructure/adapters/twilio/TwilioContentGateway.ts` | Modified | `createTemplate()` branches `types` on `input.button` |
| `src/infrastructure/http/routes/templates.routes.ts` | Modified | Forward type-guarded `body.button` |
| `src/infrastructure/http/routes/external-messaging.routes.ts` | Modified | `CreateTemplateBodySchema` gains `button` |
| `src/__tests__/application/messaging/CreateTemplate.test.ts` | Modified | +8 tests |
| `src/__tests__/infrastructure/adapters/twilio/TwilioContentGateway.admin.test.ts` | Modified | +4 tests |
| `src/__tests__/infrastructure/templates.routes.test.ts` | Modified | +2 tests |
| `src/__tests__/infrastructure/external-messaging-templates.routes.test.ts` | Modified | +2 tests |

## TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 2.1/2.2 | `CreateTemplate.test.ts` | Unit | ✅ 7/7 baseline | ✅ Written (8 failed pre-GREEN) | ✅ 15/15 passed | ✅ 8 cases (valid/invalid title/url/missing keys/placeholder) | ➖ None needed |
| 3.1/3.2 | `TwilioContentGateway.admin.test.ts` | Unit | ✅ 18/18 baseline | ✅ Written (2 failed pre-GREEN) | ✅ 22/22 passed | ✅ 4 cases (no-button regression, with-button, placeholder) | ➖ None needed |
| 4.1/4.2 | `templates.routes.test.ts` | Integration (supertest) | ✅ 21/21 baseline | ✅ Written (2 failed pre-GREEN) | ✅ 42/42 passed | ✅ 2 cases (valid/invalid) | ➖ None needed |
| 4.3/4.4 | `external-messaging-templates.routes.test.ts` | Integration (supertest) | ✅ 19/19 baseline | ✅ Written (2 failed pre-GREEN) | ✅ 25/25 passed | ✅ 2 cases (valid/invalid) | ➖ None needed |

### Test Summary
- **Total tests written**: 16 (8 + 4 + 2 + 2)
- **Total tests passing**: 104/104 in the 4 targeted suites (15+22+42+25)
- **Layers used**: Unit (12), Integration (4)
- **Approval tests**: None — no refactoring tasks, purely additive
- **Pure functions created**: 1 (`assertValidButton`)

## Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `npx jest CreateTemplate.test TwilioContentGateway.admin.test templates.routes.test external-messaging-templates.routes` → all green (104 tests across 4 suites) |
| Runtime harness command/scenario and exact result | N/A — pure unit/route tests against in-memory gateway, no live Twilio call required (per design/tasks) |
| Rollback boundary | Single commit `32adcf47`; `git revert 32adcf47` removes `button` end-to-end; additive field, no migration, no data touched |

## Full Suite + tsc Verification

- `npx tsc --noEmit` → clean, exit 0, zero errors.
- `npm test` (full suite) → `Test Suites: 1 failed, 6 skipped, 1284 passed, 1285 of 1291 total. Tests: 1 failed, 88 skipped, 13602 passed, 13691 total.`
  - The 1 failure was `externalV1.news.routes.test.ts` (multipart 40MB batch upload test, 5000ms timeout) — unrelated file, no code in this change touches news routes or multipart uploads.
  - Re-ran that suite in ISOLATION (no concurrent process): `32/32 passed`, including the previously-timed-out test. Confirmed CPU contention artifact (ran concurrently with `tsc --noEmit` in a separate background process) per project convention ("suite bajo contención no es medición"), NOT a regression from this change.
  - No test in any of the 4 targeted suites, nor in the rest of the messaging/templates suite, failed.

## Review Workload

- Estimated: ~260-300 lines. Actual authored: 322 lines (11 files, +324/-2, excluding the 3 new openspec artifact files copied from Engram which are documentation, not code).
- Full commit diffstat (incl. openspec docs): 14 files, +476/-2.
- Within the 400-line budget. Single PR, no chaining needed.

## Deviations from Design

None — implementation matches design exactly:
- Singular `button?: {title, url}`, not an array.
- Validation lives in `CreateTemplate.ts` as module-private `assertValidButton()`.
- Raw url string stored/sent (never `.href`) to avoid percent-encoding Twilio placeholders.
- Both `templates.routes.ts` and `external-messaging.routes.ts` updated.
- `/validate` and `/send` untouched (confirmed unnecessary, `extractTemplateBody()` already tolerant).

## Issues Found

None.

## Remaining Tasks

None — all 13 tasks complete.

## Status

13/13 tasks complete. Ready for sdd-verify.
