# Archive Report: WhatsApp Template CTA Button

**Change**: `whatsapp-template-buttons`
**Status**: ARCHIVED
**Date Archived**: 2026-09-10
**Change Implementation Date**: 2026-09-09

## Change Summary

Added optional `button?: {title: string, url: string}` field to WhatsApp template creation (`POST /api/external/v1/messaging/templates`). When a button is provided, the gateway emits `twilio/call-to-action` with URL action; when absent, the payload remains `twilio/text` (byte-identical to prior behavior). Buttons do not appear in preview rendering — the gap is accepted and documented.

## Final State Authority

**Ranking of sources** (per sdd-archive SKILL.md):
1. ✅ **Persisted tasks artifact** (`openspec/changes/archive/2026-09-09-whatsapp-template-buttons/tasks.md`): All 13 implementation tasks completed and marked `[x]`
2. ✅ **Explicit final-state facts from launch prompt**: Code merged to `main` via PR #160 (commit `acab519d`), deployed to production successfully, sdd-verify PASSED (13619/13619 tests, tsc clean)
3. ✅ **Verify-report** (Engram observation #2742, also now persisted at `openspec/changes/archive/2026-09-09-whatsapp-template-buttons/verify-report.md`): PASS verdict with all 8 scenarios covered

**No contradictions between sources.** All intermediate snapshots align with final state facts.

## Tasks Completion

**Source**: `openspec/changes/archive/2026-09-09-whatsapp-template-buttons/tasks.md`

All 13 implementation tasks marked complete (`[x]`):
- Phase 1: Foundation — 3 tasks (port, DTO, in-memory gateway)
- Phase 2: Use-case validation — 2 tasks (RED + GREEN for `CreateTemplate`)
- Phase 3: Gateway payload — 2 tasks (RED + GREEN for `TwilioContentGateway`)
- Phase 4: Route wiring — 4 tasks (RED + GREEN for both `templates.routes.ts` and `external-messaging.routes.ts`)
- Phase 5: Verification — 2 tasks (targeted suite + VAL-3 regression check)

## Verification Results

**Source**: Engram observation #2742 + persisted `verify-report.md`

| Metric | Result |
|--------|--------|
| Test Suites | 1285 passed, 0 failed, 1291 total (6 skipped) |
| Tests | 13619 passed, 0 failed, 13707 total (88 skipped) |
| TypeScript | Clean, exit 0 |
| Requirements Coverage | TPL-3 (5 scenarios) + VAL-3 (3 scenarios) = 8/8 compliant |
| CRITICAL Issues | 0 |
| Verdict | **PASS** |

**Monotonicity verification**: Pass 2 (fix-wave re-run at commit `2b92a562`) showed +17 tests passing and +16 new tests (interior-whitespace fix wave), with no regressions. All 4 targeted suites green.

## Specs Synced

| Domain | Action | Requirement | Change |
|--------|--------|-------------|--------|
| `external-bulk-messaging` | MODIFIED | TPL-3 | Upgraded title: "creación de template, con botón CTA opcional". Payload now branches on `input.button` to emit `twilio/call-to-action` (with actions) or `twilio/text` (no change). Added 3 new scenarios: no-button regression, valid-button success, invalid-button 400 cases. |
| `external-bulk-messaging` | MODIFIED | VAL-3 | Clarified that button templates render identically to text templates (body-only in `renderedMessage`; button not exposed). Added scenario: CTA button missing from preview. Updated requirement description to document the button-transport behavior. |

**Source main spec**: `openspec/specs/external-bulk-messaging/spec.md` (189 lines → 215 lines)
**Delta spec location**: `openspec/changes/archive/2026-09-09-whatsapp-template-buttons/specs/external-bulk-messaging/spec.md`

## Files Modified (Implementation)

All changes closed; 11 files touched in the live codebase (committed and deployed):

| File | Role | Status |
|------|------|--------|
| `src/domain/ports/TemplateMessagingPort.ts` | Port interface | ✅ Button field added |
| `src/application/dto/messaging-templates.dto.ts` | DTO definition | ✅ Button field added |
| `src/application/use-cases/messaging/CreateTemplate.ts` | Use case + validation | ✅ assertValidButton() helper added |
| `src/infrastructure/adapters/in-memory/InMemoryTemplateMessagingGateway.ts` | Test fake | ✅ Button recorded in createCalls |
| `src/infrastructure/adapters/twilio/TwilioContentGateway.ts` | Gateway adapter | ✅ types branch on button presence |
| `src/infrastructure/http/routes/templates.routes.ts` | Admin route | ✅ Button forwarded |
| `src/infrastructure/http/routes/external-messaging.routes.ts` | External route | ✅ Zod schema extended |
| `src/__tests__/application/messaging/CreateTemplate.test.ts` | Test suite | ✅ +8 tests |
| `src/__tests__/infrastructure/adapters/twilio/TwilioContentGateway.admin.test.ts` | Test suite | ✅ +4 tests |
| `src/__tests__/infrastructure/templates.routes.test.ts` | Test suite | ✅ +2 tests |
| `src/__tests__/infrastructure/external-messaging-templates.routes.test.ts` | Test suite | ✅ +2 tests |

## SDD Artifacts

| Artifact | Status | Location |
|----------|--------|----------|
| proposal.md | ✅ Archived | `openspec/changes/archive/2026-09-09-whatsapp-template-buttons/proposal.md` |
| design.md | ✅ Archived | `openspec/changes/archive/2026-09-09-whatsapp-template-buttons/design.md` |
| tasks.md | ✅ Archived | `openspec/changes/archive/2026-09-09-whatsapp-template-buttons/tasks.md` (13/13 tasks complete) |
| specs/ | ✅ Archived | `openspec/changes/archive/2026-09-09-whatsapp-template-buttons/specs/external-bulk-messaging/spec.md` |
| apply-progress.md | ✅ Archived | `openspec/changes/archive/2026-09-09-whatsapp-template-buttons/apply-progress.md` |
| verify-report.md | ✅ Archived | `openspec/changes/archive/2026-09-09-whatsapp-template-buttons/verify-report.md` |

## Design Decisions Preserved

Per `design.md` and confirmed in implementation:
1. **Singular button shape** (`button?: {title, url}`) not plural array — widening to plural later is backward-compatible
2. **URL sent as-is** (never `.href` after `new URL()`) to preserve Twilio placeholder syntax like `{{1}}`
3. **Validation in use case** (module-private `assertValidButton()`) not Zod, because TWO routes feed the same use case
4. **Both HTTP surfaces updated** (`templates.routes.ts` hand-map + `external-messaging.routes.ts` Zod) — both must funnel through `CreateTemplate`
5. **Button-only gap documented** — preview renders body-only; button not exposed in `/validate` response

## Known Issues & Notes

**Non-blocking observations** (per verify-report):
- `apply-progress.md` content is stale (32adcf47 snapshot, not the fix-wave commits); verify-report supersedes it
- No interior-whitespace test on hand-mapped surface (only on Zod); covered by use-case test
- VAL-3 "no field exposes title/url/actions" asserted at different response layers

**No CRITICAL issues.** WARNING count: 1 (stale apply-progress content, non-blocking).

## Deployment Status

✅ **Merged to main**: PR #160, commit `acab519d`, merged 2026-09-09
✅ **Deployed**: Successfully deployed to production (per launch prompt)
✅ **Live testing**: No issues reported

## Checklist

- [x] All 13 implementation tasks completed and marked in persisted tasks artifact
- [x] Verify report shows PASS (13619/13619 tests, tsc clean)
- [x] No CRITICAL issues in verification
- [x] Delta specs merged into main spec files (`external-bulk-messaging` TPL-3 and VAL-3)
- [x] Change folder moved to archive with ISO date prefix (2026-09-09)
- [x] All artifacts present in archive folder (proposal, design, tasks, specs, apply-progress, verify-report)
- [x] Archive-time mechanical copy verified with empty `diff -r` (no byte differences)
- [x] Archive report written and will be persisted to Engram

## Archive Closure

**This change is COMPLETE and CLOSED.** The SDD cycle is finished:
- ✅ Proposed (proposal.md)
- ✅ Specified (spec.md)
- ✅ Designed (design.md)
- ✅ Tasked (tasks.md)
- ✅ Applied (code committed to main, all 13 tasks marked complete in tasks.md)
- ✅ Verified (sdd-verify PASS, 13619/13619 tests, tsc clean)
- ✅ Archived (folder moved, specs synced, report written)

Ready for next change.
