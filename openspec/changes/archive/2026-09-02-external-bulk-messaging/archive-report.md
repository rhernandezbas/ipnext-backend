# Archive Report — external-bulk-messaging

**Change**: external-bulk-messaging  
**Archived**: 2026-09-02  
**Status**: SUCCESS — all requirements verified, 368 tests green, no CRITICAL issues

---

## Specs Synced

| Domain | Action | Summary |
|--------|--------|---------|
| `external-bulk-messaging` | CREATED | New capability spec at `openspec/specs/external-bulk-messaging/spec.md` (full spec, 800+ lines, 17 requirements across 6 capabilities: AUTH, kill-switch, validate 2-step preview, send with idempotence, template admin, campaign status, config) |
| `messaging-bulk` | UNMODIFIED | Code-level extension only (per proposal: "sin cambiar ningún requirement existente"); `SendCampaign` gains recipient-level variable override + `CampaignRecipient.variables` nullable field — non-breaking, tested via SEND-10 scenario |

---

## Artifact Contents (Archive)

Archive path: `openspec/changes/archive/2026-09-02-external-bulk-messaging/`

- ✅ `proposal.md` (14KB) — 2 pasos, key dedicada, preview con TTL, kill-switch, topes, idempotence
- ✅ `specs/external-bulk-messaging/spec.md` (45KB) — RFC-2119 compliant, 56 scenarios across 17 requirements
- ✅ `design.md` (53KB) — data model, routes, error codes, composition-root order (COMP-1), TDD probes
- ✅ `tasks.md` (33KB) — 56 tasks across 5 batches + post-deploy runbook; 51/56 checked (B1-B4b complete, B5 FE unchecked but complete in worktree)
- ✅ `apply-progress.md` (95KB) — batch-by-batch TDD evidence, mutation tests (F1/F2 probes), 368 tests green, NO CRITICAL issues
- ✅ `verify-report.md` (23KB) — spec↔test matrix, 22 BE suites + 4 FE suites, build clean, compliance green
- ✅ `exploration.md` (19KB) — research phase, competitor analysis, constraints discovery

---

## Verification Summary

| Check | Result | Details |
|-------|--------|---------|
| **Build** | ✅ PASS | `npx tsc --noEmit` clean (0 errors) — 2nd sanity check recommended before merge |
| **Tests (BE)** | ✅ PASS | 22 suites / 368 tests, all green (use-case + infra + reused paths) |
| **Tests (FE)** | ✅ PASS | 4 suites / 52 tests, all green (types, hooks, API client, component + a11y) |
| **TDD Compliance** | ✅ VERIFIED | RED/GREEN/REFACTOR cycles documented per requirement, mutation probes explicit (F1/F2) |
| **Spec Compliance** | ✅ COMPLIANT | All 17 requirements mapped to test suites, no gaps in coverage |
| **Code Quality** | ✅ VERIFIED | DIP strict (no infra imports in domain/application), error codes registerd in wire format |
| **No Regressions** | ✅ TESTED | SEND-10 scenario: `recipient.variables = null` → behavior identical to pre-change `messaging-bulk` |

---

## Key Architectural Decisions

1. **Preview ≠ Campaign**: `ValidateExternalBulk` persists `ExternalBulkPreview` (TTL 15min) WITHOUT creating a Campaign — avoids inflating quota/history
2. **Re-validation on send**: `SendExternalBulk` re-checks flag, template approval, quota, opt-out at send time — a valid preview can reject if state changed
3. **Quota counts authorizaton, not delivery**: Daily quota burns when `Campaign` is created, not when it's sent — prevents gap where lock-busy campaigns reset quota
4. **Recipient-level variable override**: Variables per-recipient override global variables by key (merge, not replacement) — enables per-person personalization from external API
5. **Dedicated key + kill-switch**: Two independent gates (AUTH-1/2/3 + KS-1) ensure this feature can be toggled/suspended independently from global `/api/external/v1`
6. **Order matters (COMP-1)**: Router mounted BEFORE global `/api/external/v1` middleware to prevent global key intercepting dedicated-key routes

---

## Downstream Notes

### For Next Changes (FE Integration)

- Batch B5 (FE) is **implementation-complete** in `ipnext-frontend/.claude/worktrees/external-bulk-messaging-fe` (5 files + tests passing)
- Recommend task-sync in next FE change SDD to check off B5.1-B5.4 + Gate B5 in that repo's tasks mirror
- FE component models `WhatsappSettingsPage` (toggle + config inputs, per proposal)

### For Skill `whatsapp-bulk-ipnext`

- External caller now has validated M2M surface: `POST /validate` + `POST /send` with 2-step preview
- Key + flag can be configured via `SetExternalBulkConfig` (admin UI)
- API contracts stable and RFC-2119 compliant — ready for skill consumption post-archive

### Spec Archive Convention

- Main spec synced to `openspec/specs/external-bulk-messaging/spec.md` — **source of truth for capability**
- `messaging-bulk` spec: still absent from main specs (deferred debt — spec lives in archived change folders); this change REUSES without modifying spec
- Future delta changes touching `external-bulk-messaging` or `messaging-bulk` will reference `openspec/specs/external-bulk-messaging/` as source

---

## SDD Cycle Status

- ✅ **Exploration** (2026-09-02): Codebase audited, constraints documented
- ✅ **Proposal** (2026-09-02): Scope, approach, rollback plan, data model
- ✅ **Spec** (2026-09-02): RFC-2119 requirements, 56 scenarios, test matrix
- ✅ **Design** (2026-09-02): Routes, DTOs, error codes, composition-root, TDD probes  
- ✅ **Tasks** (2026-09-02): 56 tasks, 5 batches, B1-B4b complete (B5 FE unblocked)
- ✅ **Apply** (2026-09-02): Batches B1-B4b implemented, 368 tests green, fix waves F1/F2 applied
- ✅ **Verify** (2026-09-02): All 17 requirements verified against test matrix, no CRITICAL issues
- ✅ **Archive** (2026-09-02): Specs synced, change folder moved, report written

**Change ready for merge to main.**

---

*Archive completed by SDD phase agent — archive-report saved to engram topic `sdd/external-bulk-messaging/archive-report`*
