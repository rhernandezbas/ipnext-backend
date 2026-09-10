# Apply Progress — whatsapp-invoice-detail-quickreply

Retrospective write-up. This artifact was never produced during the original run: the
`sdd-apply` session was interrupted mid-way by a session rate-limit error, and the orchestrator
finished the remaining verification and commit steps manually afterwards. Nothing below is new
work — it documents work that was already completed and committed.

## Scope

All 26 tasks in `tasks.md` (Phases 0–8) were implemented.

| Phase | What shipped |
|-------|--------------|
| 0 — Pre-flight | Repo-wide audit of button-shaped call sites; QR-4 scenario reconciled with the design's owner-locked fallback decision. |
| 1 — Foundation | `TemplateButton` tagged union (`url` \| `quickReply`), `INVOICE_DETAIL_BUTTON_TITLE` + `isInvoiceDetailTrigger`, normalization in `CreateTemplate.assertValidButton` (missing `type` → `url`). |
| 2 — Provider adapter | `twilio/quick-reply` branch in `TwilioContentGateway` (`actions:[{id,title}]`) plus the mirrored branch in `InMemoryTemplateMessagingGateway`. |
| 3 — Reader port | `InvoiceDetailReader` port, `PrismaInvoiceDetailReader` (explicit `select`, no PII columns), `InMemoryInvoiceDetailReader` test double. |
| 4 — Pure formatter | `renderInvoiceDetailReply` — total pure function; `null` = GR lookup failed, `[]` = zero pending invoices; both owner-locked strings exported as constants. |
| 5 — Orchestrator | `ReplyWithInvoiceDetail` — trigger → E.164 → client lookup → stale-balance refresh → reader → formatter → `ChatwootGateway.sendMessage`; own try/catch, never throws. Zero imports from `assistant/*`, never reads `ai-assistant-enabled` (QR-2). |
| 6 — Webhook wiring | Optional 9th constructor collaborator on `ReceiveChatwootWebhook` + `maybeReplyWithInvoiceDetail`, modeled byte-for-byte on the fail-open `maybeRegisterOptOut` pattern, inbound-only. |
| 7 — Composition | `app.ts` wires `PrismaInvoiceDetailReader` + `ReplyWithInvoiceDetail`, guarded on GR being configured; supertest integration coverage over the real webhook route. |
| 8 — Regression | Full suite + spec-text reconciliation. |

## Timeline and evidence

1. **Implementation — commit `acaebaad`** (`feat(messaging): quick-reply button auto-replies with real GR invoice detail`).
   Full Jest suite green, `npx tsc --noEmit` clean.

2. **Adversarial review — 5 findings.**
   - CRITICAL: ambiguous-phone data leak (one phone resolving to more than one client could surface the wrong client's invoices).
   - HIGH: raw ISO date rendered to the customer instead of a locale-appropriate due date.
   - HIGH: unbounded message overflow — no cap on total reply length.
   - MEDIUM: fail-open gap — an internal error produced silence instead of the owner-locked fallback message.
   - MEDIUM: external route mishandled a quick-reply button (`{type:'quickReply', title}` rejected; `{type:'quickReply', title, url}` silently downgraded to a URL button).

3. **Fix wave — commit `448ce327`** (`fix(messaging): fix wave del quick-reply de detalle de facturas (5 hallazgos)`).
   TDD, RED then GREEN evidence recorded per finding. All five fixed.

4. **Re-review — clean**, with one accepted LOW residual risk: a theoretical single invoice block over ~1400 characters could push out the "more invoices" notice. Accepted — real MercadoPago URLs are around 100 characters, so the bound is not reachable with production data.

## Post-hoc verification pass (this fix wave)

`sdd-verify` later flagged three verification gaps, all closed on top of `448ce327`:

- TPL-3 had a scenario for an EXPLICIT `type:'url'` button but every test only built the untyped legacy shape. Added a use-case test asserting explicit-vs-legacy equivalence (and that url validation still applies) plus an external-route wire test.
- TPL-6 (Meta recategorizing `UTILITY` → `MARKETING`) had no test. The read-back mechanism already existed and was already correct: `toTemplateDto` prefers the `ApprovalRequests` category over the submitted one. Added a gateway test putting both sources in CONFLICT — a revert-probe (flipping the `??` operand order) makes only that test fail, so it genuinely discriminates. No production code was needed; this was a missing test, not a missing feature.
- QR-4's requirement HEADING still read "no reply on unresolved phone or internal error", contradicting its own already-corrected scenario body. Heading reworded to "fail-open; owner-locked fallback reply on internal error, no reply on unresolved phone" — both sub-cases (fallback on GR/internal error, genuine silence on a zero-match phone) are now stated accurately.

Full suite after this pass: 1290 suites passed / 6 skipped, 13675 tests passed / 88 skipped. `npx tsc --noEmit` clean.

## Commits

- `acaebaad` — implementation of all 26 tasks.
- `448ce327` — adversarial-review fix wave (5 findings).
- `664fa267` — closes 3 sdd-verify blockers (missing tests for TPL-3 explicit `type:'url'` and TPL-6 category-conflict discrimination, QR-4 heading wording).
- `f3134cc5` — this retrospective apply-progress.md.
- (doc-only, no code) spec text corrected in `specs/external-bulk-messaging/spec.md` + `tasks.md` 1.6 note — the third `sdd-verify` pass found the spec prose itself was stale in 3 places (quick-reply `actions` shape, stray-`url` handling, anti-drift title match), all confirmed as spec-authoring lag behind the fix-wave's deliberate hardening, not a code defect.
