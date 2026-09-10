# Verify Report: WhatsApp Template CTA Button

**Change**: `whatsapp-template-buttons`
**Status**: PASS
**Verified at**: Commit `2b92a562` (fix-wave SECOND pass, full re-verification)
**Date**: 2026-09-09

## Verdict

**PASS** — All 13619 tests passing, tsc clean. All 8 scenarios (TPL-3 + VAL-3) compliant with covering tests.

## Test Results

```
Test Suites: 6 skipped, 1285 passed, 1285 of 1291
Tests: 88 skipped, 13619 passed, 0 failed, 13707 total
Exit: 0
```

- `npm test` run with no concurrent processes (per project convention: "suite bajo contencion no es una medicion").
- `npx tsc --noEmit` → clean, exit 0.

## Requirements Coverage

### Requirement: TPL-3 — creación de template, con botón CTA opcional

**Status**: PASS (5 scenarios, all passing tests)

#### Scenarios
1. ✅ **creación válida sin botón — sin regresión**
   - Test: `CreateTemplate.test.ts` "no-button payload stays byte-identical"
   - Evidence: `TwilioContentGateway.admin.test.ts` covers the exact payload shape and `templates.routes.test.ts` verifies the route integration.

2. ✅ **creación con botón CTA válido**
   - Test: `CreateTemplate.test.ts` "valid button reaches createCalls[0].button"
   - Evidence: `TwilioContentGateway.admin.test.ts` "with-button payload is twilio/call-to-action", `templates.routes.test.ts` "201 + fake's createCalls[0].button populated", `external-messaging-templates.routes.test.ts` same coverage.

3. ✅ **botón inválido (título vacío o url mal formada/no http-s) → 400**
   - Test: `CreateTemplate.test.ts` has 6 cases: whitespace-only title, >25 char title, relative url, ftp:// url, missing title key, missing url key.
   - Evidence: All routes (`templates.routes.test.ts`, `external-messaging-templates.routes.test.ts`) verify 400 on invalid button.

4. ✅ **body vacío — sin regresión**
   - Test: `CreateTemplate.test.ts` "400 on empty body" (existing test, still passing).
   - Evidence: No regression in baseline tests.

5. ✅ **category fuera del enum — sin regresión**
   - Test: `CreateTemplate.test.ts` "400 on invalid category" (existing test, still passing).
   - Evidence: No regression in baseline tests.

### Requirement: VAL-3 — renderizado del mensaje POR RECIPIENT

**Status**: PASS (3 scenarios, all passing tests)

#### Scenarios
1. ✅ **dos recipients, dos mensajes distintos**
   - Test: `ValidateExternalBulk.test.ts` "renders per-recipient with distinct variables" (existing test, still passing).
   - Evidence: No regression.

2. ✅ **sin recipients válidos no hay muestra**
   - Test: `ValidateExternalBulk.test.ts` "responds 422 EMPTY_RECIPIENTS when no valid recipients" (existing test, still passing).
   - Evidence: No regression.

3. ✅ **preview de un template con botón CTA no muestra el botón (nuevo)**
   - Test: `ValidateExternalBulk.test.ts:431` (end-to-end through use case) + 4 in `TwilioContentGateway.test.ts`:
     - Direct `extractTemplateBody` test for `twilio/call-to-action` type, verifying body-only extraction.
     - Direct `extractTemplateBody` test for CTA-only-actions empty-string fallback.
     - `listTemplates` pass asserting serialized template lacks button title/url/actions.
   - Evidence: 5 covering tests total. Button never appears in `renderedMessage` or any validate-layer response field.

## Interior-Whitespace Fix Verification

**Issue**: First pass (commit `32adcf47`) had VAL-3 scenario 3 uncovered. Fix wave added validation in `CreateTemplate.ts:56` to reject interior whitespace/control chars in url.

**Verification**: Both create surfaces confirmed fixed.
- Hand-mapped `templates.routes.ts:68-81`: forwards raw `body['button']` verbatim; old route-level type guard removed in fix wave (correct call: silent 201-without-feature is worse than 400).
- Zod `external-messaging.routes.ts:135`: validates shape only, then `execute(body)` hits the same `assertValidButton()`.

**Location in code**: `CreateTemplate.ts:56`, AFTER `.trim()` and empty/length guards, BEFORE `new URL()`. Edge whitespace normalizes away; only genuine interior whitespace is rejected.

**Why this matters**: `new URL()` silently strips interior whitespace while the raw unnormalized string is what reaches Twilio.

## Test Count Progression

| Phase | Test Suites | Tests Passed | Notes |
|-------|-------------|--------------|-------|
| `32adcf47` (pass 1) | 1284 passed, 1 failed | 13602 passed / 1 failed / 13691 total | VAL-3 scenario 3 uncovered; CPU contention artifact on news route |
| `2b92a562` (pass 2, fix wave) | **1285 passed, 0 failed** | **13619 passed, 0 failed / 13707 total** | +16 new tests (all 4 suites), +17 passed (news timeout resolved under isolation) |

**Monotonicity**: +17 passed, +16 total tests (the 16 fix-wave tests + news timeout resolution). No regression.

## Issues Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 0 | — |
| WARNING | 1 | `apply-progress.md` content is stale (32adcf47 snapshot, not fix-wave); non-blocking (verify-report supersedes) |
| SUGGESTION | 3 | No interior-whitespace test on hand-mapped surface; VAL-3 "no field exposes title/url/actions" asserted at different layers; 4 commits unpushed |

## Compliance Summary

✅ **All TPL-3 scenarios passing**
✅ **All VAL-3 scenarios passing**
✅ **Zero CRITICAL issues**
✅ **No regressions**
✅ **tsc clean**
✅ **Both HTTP create surfaces verified**

---

**Archive Status**: Ready for archive. All verification gates passed.
