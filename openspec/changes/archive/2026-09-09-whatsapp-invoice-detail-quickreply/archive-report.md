# Archive Report: WhatsApp Invoice Detail Quick-Reply

**Change**: whatsapp-invoice-detail-quickreply
**Archived**: 2026-09-10 (post-verification and live production smoke test)
**Archive path**: `openspec/changes/archive/2026-09-09-whatsapp-invoice-detail-quickreply/`

## Executive Summary

Change fully implemented, verified (pass 4, 13675/13675 tests, tsc clean), merged to main via PR #161 (commit range acaebaad..65beccff), deployed to production, and live-smoke-tested successfully 2026-09-10 with a real Gestión Real client. Added `quickReply` button type to template creation (on top of sibling `whatsapp-template-buttons` CTA-URL form), plus an isolated deterministic webhook handler that replies with real pending invoice data (DD/MM/YYYY format, working links, correct "más facturas" truncation).

## Specs Synced

| Domain | Action | Details |
|--------|--------|---------|
| external-bulk-messaging | Modified | TPL-3: expanded to union `{type:'url',...} \| {type:'quickReply',...}`; TPL-6: new requirement documenting Meta recategorization of quick-reply templates from UTILITY→MARKETING |
| whatsapp-invoice-detail-quickreply | Created | New capability spec (QR-1 through QR-4): trigger detection via exact title match, full isolation from assistant feature, deterministic invoice resolution, fail-open with owner-locked fallback |

### TPL-3 Changes (external-bulk-messaging)

**Modified requirement**: Template creation button shape → discriminated union.

- **Legacy `{title, url}`** (production today): Still accepted, treated as `{type:'url', title, url}` — byte-identical.
- **Explicit `{type:'url', title, url}`**: Equivalent to legacy; emits `twilio/call-to-action` with `actions:[{type:'URL', title, url}]`.
- **New `{type:'quickReply', title}`**: Emits `twilio/quick-reply` with `actions:[{id:<slug>, title}]`; title MUST be exactly `INVOICE_DETAIL_BUTTON_TITLE` (anti-drift gate at creation).
- **Validation**: `url` present alongside `quickReply` → 400 rejection (no silent drop); unknown `type` → 400; empty/non-matching `quickReply` title → 400.
- **No-button path**: Still emits `twilio/text` (zero regression).

Scenarios: legacy, explicit url, valid quick-reply, quick-reply with stray url (400), unknown type / empty title / non-matching quick-reply title (400), no button (regression test).

### TPL-6 New Requirement (external-bulk-messaging)

**New requirement**: Meta may recategorize approval category away from what was submitted.

- **Observable fact**: Quick-reply template submitted as UTILITY was approved by Meta under MARKETING (~5x cost difference per message).
- **System obligation**: Always report the REAL `approvalCategory` from Meta (via TPL-2 `GET .../templates/:sid`), never assume the submitted category persists.
- **Scenario**: Quick-reply submitted UTILITY, approved MARKETING → `GET .../templates/:sid` reflects `approvalCategory:'MARKETING'`.

### QR-1 through QR-4 (whatsapp-invoice-detail-quickreply)

**New capability spec** defining the isolated quick-reply feature:

- **QR-1 — Trigger detection**: Button tap arrives as normal inbound message (content = button title, no payload/id); detection by exact, case-insensitive, trimmed match against fixed constant `INVOICE_DETAIL_BUTTON_TITLE`.
- **QR-2 — Full isolation**: Zero imports from `assistant/*`, never reads `ai-assistant-enabled` flag; feature runs regardless of that flag's state.
- **QR-3 — Deterministic resolution**: Phone → Client (canonical E.164), fetch real pending GR invoices, reply with itemized block (número, vencimiento, saldo, "Ver" link, "Pagar ahora" link), separated by dividers.
- **QR-4 — Fail-open; owner-locked fallbacks**: Optional webhook collaborator, try/catch, webhook always acks 200; no phone match → no reply; lookup failure → exact owner-locked fallback message, no rethrow.

## Archive Contents

- **proposal.md** ✅ — Intent, scope, approach, risks, success criteria
- **design.md** ✅ — Technical approach, architecture decisions, data flow, file changes, testing strategy
- **tasks.md** ✅ — 26/26 tasks complete; 8 phases (pre-flight, foundation, provider adapter, reader, formatter, orchestrator, webhook wiring, regression + cleanup)
- **specs/** ✅
  - **external-bulk-messaging/spec.md** — Delta: TPL-3 MODIFIED (union button), TPL-6 ADDED (Meta recategorization)
  - **whatsapp-invoice-detail-quickreply/spec.md** — Full spec: QR-1 through QR-4
- **apply-progress.md** ✅ — 5 commits (acaebaad, 448ce327, 664fa267, f3134cc5, 792b6ba6), all tasks tracked
- **verify-report.md** ✅ — Pass 4: 13675/13675 tests, tsc clean, 0 CRITICAL, 0 WARNING, all 26 tasks complete

## Task Completion Verification

All 26 implementation tasks are complete and checked in persisted `tasks.md`:

| Phase | Count | Status |
|-------|-------|--------|
| Phase 0 (Pre-flight) | 2 | ✅ |
| Phase 1 (Foundation) | 6 | ✅ |
| Phase 2 (Provider adapter) | 4 | ✅ |
| Phase 3 (Reader port) | 4 | ✅ |
| Phase 4 (Pure formatter) | 2 | ✅ |
| Phase 5 (Orchestrator) | 2 | ✅ |
| Phase 6 (Webhook wiring) | 2 | ✅ |
| Phase 7 (Composition) | 2 | ✅ |
| Phase 8 (Regression + cleanup) | 2 | ✅ |
| **Total** | **26** | **✅** |

## Final-State Observations

### Source of Truth Updated

The following specs now reflect the complete shipped behavior:

- `openspec/specs/external-bulk-messaging/spec.md` — TPL-3 (union button) and TPL-6 (recategorization)
- `openspec/specs/whatsapp-invoice-detail-quickreply/spec.md` — New capability, fully isolated

### Live Production Verification

**2026-09-10**: Change deployed to production and smoke-tested LIVE with real Gestión Real customer. Customer tapped the "Ver mis facturas" quick-reply button; system correctly:

1. **Detected the button tap** via exact title match (case-insensitive, trimmed)
2. **Resolved phone to Client** using canonical E.164 normalization
3. **Fetched pending invoices** from Gestión Real (API call reused via `RefreshClientBalanceIfStale` → `GestionRealClient`)
4. **Rendered reply** with correct format: each invoice (número, DD/MM/YYYY vencimiento, saldo), "Ver" link (PDF), "Pagar ahora" link (MercadoPago)
5. **Sent as free-text message** into the live Chatwoot conversation
6. **Reply arrived within 3 seconds** (end-to-end latency)
7. **"Más facturas" truncation message** displayed correctly when invoice list exceeded display budget (MAX_INVOICES_IN_REPLY=5, MAX_REPLY_LENGTH=1400)

No regressions observed in surrounding webhook processing (opt-out handling, message mirroring, assistant feature flag state).

### Verification Evidence

| Check | Result |
|-------|--------|
| Test suite (npm test) | 1290 suites / 13675 tests passed, 0 failed, 88 skipped, exit 0 |
| Type check (tsc --noEmit) | Clean, zero diagnostics |
| Verify pass 4 | PASS — doc-only spec-text correction, all 26 tasks complete, 3 CRITICAL mismatches closed |
| Spec compliance (6/6 requirements, 14/14 scenarios) | All covered by passing Jest tests |
| Live smoke test (2026-09-10) | PASS — real customer, real invoices, correct formatting, 3s latency, no regressions |

## Risks

**None identified**. All CRITICAL spec-prose mismatches were closed during verify pass 4; all 26 tasks complete and checked; live smoke test confirms deterministic behavior in production.

### Residual Accepted Risk (unchanged from design)

- Single invoice block over ~1400 characters could theoretically displace "more invoices" notice. Bounded: real MercadoPago URLs ~100 chars; `MAX_REPLY_LENGTH = 1400` and `MAX_INVOICES_IN_REPLY = 5` enforced and tested.

## Artifact Lineage

- Proposal: intent + approach B (full isolation, zero assistant imports)
- Design: arch decisions + data flow + testing strategy
- Spec (external-bulk-messaging delta): TPL-3 union + TPL-6 recategorization
- Spec (whatsapp-invoice-detail-quickreply new): QR-1 through QR-4, isolated capability
- Design decisions: tagged union normalization at boundary; trigger by exact title constant; isolated module; fail-open webhook
- Commits:
  - acaebaad: Phase 1–2 RED/GREEN foundation + provider adapter
  - 448ce327: Phase 1.6 RECONCILIATION — reject stray url on quickReply (review finding 5)
  - 664fa267: Phase 3–7 RED/GREEN reader + formatter + orchestrator + webhook + composition
  - f3134cc5: Phase 8 full regression suite + cleanup
  - 792b6ba6: Doc-only spec-text corrections (pass 4 hygiene)

## SDD Cycle Complete

The change has been fully planned (proposal), specified (delta + new spec), designed (arch decisions + file changes), implemented (5 commits, 420 LOC source + 380 LOC tests), verified (4 passes, 13675 tests, tsc clean), and deployed (production merge 2026-09-09, smoke test 2026-09-10).

Ready for next change. No follow-up work required.
