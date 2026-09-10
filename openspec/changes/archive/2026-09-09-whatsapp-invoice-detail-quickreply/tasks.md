# Tasks: WhatsApp invoice-detail quick-reply

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~800 (source ~420 + tests ~380) across 13 modified/new files |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 → PR 2 → PR 3 |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending — ask the user |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Tagged-union button + Twilio/in-memory `quick-reply` branch (Phase 0-2) | PR 1 | `npm test -- CreateTemplate TwilioContentGateway InMemoryTemplateMessagingGateway` | N/A — pure unit/adapter tests, no external call | Revert `TemplateButton`, `assertValidButton`, gateway branches; legacy CTA path untouched |
| 2 | `InvoiceDetailReader` port + Prisma/in-memory readers + pure formatter (Phase 3-4) | PR 2 | `npm test -- InvoiceDetailReader renderInvoiceDetailReply` | N/A — new files unreferenced until PR 3 wires them | Delete the 4 new files; zero call sites reference them yet |
| 3 | `ReplyWithInvoiceDetail` orchestrator + webhook/app.ts wiring (Phase 5-7) | PR 3 | `npm test -- ReplyWithInvoiceDetail ReceiveChatwootWebhook` | Manual: tap-simulated inbound webhook against local Chatwoot sandbox (or supertest E2E in 7.1) | Omit the 8th ctor arg in `app.ts` to restore prior webhook behavior exactly |

## Phase 0: Pre-flight

- [x] 0.1 Repo-wide audit confirmed: only `src/infrastructure/http/routes/templates.routes.ts` and `src/infrastructure/http/routes/external-messaging.routes.ts` construct button-shaped request bodies; no other call site builds a `CreateTemplateInput`/provider button object directly. Re-run `rg "TemplateMessagingPort|\.createTemplate\(" src` before starting Phase 1 to catch drift.
- [x] 0.2 Reconcile `specs/whatsapp-invoice-detail-quickreply/spec.md` Requirement QR-4 scenario "GR lookup fails" — current text says "no reply is sent"; the design's fallback decision + owner-locked copy require sending the apologetic fallback message instead. Update the scenario to state the fallback message is sent, webhook still acks 200, no rethrow.

## Phase 1: Foundation — tagged union + trigger constant

- [x] 1.1 RED: `src/__tests__/application/messaging/CreateTemplate.test.ts` — add cases: legacy `{title,url}` still → `url`; `type:'quickReply'` with matching title accepted; `type:'quickReply'` with foreign title → 400; unknown `type` → 400.
- [x] 1.2 GREEN: `src/domain/ports/TemplateMessagingPort.ts` — `TemplateButton` → `{type:'url';title;url} | {type:'quickReply';title}`.
- [x] 1.3 GREEN: `src/application/dto/messaging-templates.dto.ts` — widen `button` to `{type?: unknown; title?: unknown; url?: unknown}`.
- [x] 1.4 RED: `src/__tests__/application/messaging/invoice-detail/invoiceDetailButton.test.ts` — exact/case-insensitive/trim match fires; substring (`"quiero ver mis facturas"`) does not.
- [x] 1.5 GREEN: Create `src/application/use-cases/messaging/invoice-detail/invoiceDetailButton.ts` — export `INVOICE_DETAIL_BUTTON_TITLE = 'Ver mis facturas'` + `isInvoiceDetailTrigger`.
- [x] 1.6 GREEN: `src/application/use-cases/messaging/CreateTemplate.ts` `assertValidButton` — normalize missing `type`→`url`; `quickReply` requires trimmed title === `INVOICE_DETAIL_BUTTON_TITLE` (imported from 1.5) else 400. RECONCILED (review finding 5, commit `448ce327`): a stray `url` on `quickReply` is REJECTED with 400, not ignored — silently dropping it let the external route mis-create a url-type button instead of failing. Spec text corrected to match in the sdd-verify hygiene pass.

## Phase 2: Provider adapter branch

- [x] 2.1 RED: `src/__tests__/infrastructure/adapters/twilio/TwilioContentGateway.admin.test.ts` — `type:'quickReply'` → posts `types:{'twilio/quick-reply':{body, actions:[{id, title}]}}`; existing `url`/no-button cases stay green. (Added to the existing admin/createTemplate test file, not `TwilioContentGateway.test.ts` — that file covers listTemplates/sendTemplate, not createTemplate; matched actual code organization.)
- [x] 2.2 GREEN: `src/infrastructure/adapters/twilio/TwilioContentGateway.ts` — third `types` branch + `slug(title)` helper for `id`.
- [x] 2.3 RED: `src/__tests__/infrastructure/adapters/in-memory/InMemoryTemplateMessagingGateway.test.ts` — mirror the quick-reply branch assertions.
- [x] 2.4 GREEN: `src/infrastructure/adapters/in-memory/InMemoryTemplateMessagingGateway.ts` — mirror the branch.

## Phase 3: Reader port + adapters

- [x] 3.1 Create `src/domain/ports/InvoiceDetailReader.ts` — `listOpenByClientId(clientId): Promise<InvoiceDetailInvoice[]>`, explicit `select`, no PII columns.
- [x] 3.2 RED: `src/__tests__/infrastructure/PrismaInvoiceDetailReader.test.ts` — mirror read filters `status in ['pendiente','vencida']`, `orderBy dueDate asc`. (Path matches the sibling `PrismaAssistantInvoicesReader.test.ts`, which lives directly under `__tests__/infrastructure/`, not a nested `adapters/prisma/` subfolder.)
- [x] 3.3 GREEN: Create `src/infrastructure/adapters/prisma/PrismaInvoiceDetailReader.ts`.
- [x] 3.4 Create `src/infrastructure/adapters/in-memory/InMemoryInvoiceDetailReader.ts` — test double implementing the port.

## Phase 4: Pure formatter

- [x] 4.1 RED: `src/__tests__/application/messaging/invoice-detail/renderInvoiceDetailReply.test.ts` — table-driven: N invoices → itemized text + divider; omit "Pagar ahora" when `paymentUrl` null; empty list → EXACT owner-locked zero-invoices string, verbatim; lookup-failure path → EXACT owner-locked GR-lookup-fails string, verbatim; assert the zero-invoices string never contains "al día".
- [x] 4.2 GREEN: Create `src/application/use-cases/messaging/invoice-detail/renderInvoiceDetailReply.ts` — pure formatter; export both owner-locked fallback strings as named constants. Modeled as `renderInvoiceDetailReply(invoices: InvoiceDetailInvoice[] | null)`: `null` = GR lookup failed (orchestrator's catch path), `[]` = zero pending invoices (success path) — one pure total function backs both QR-3 and QR-4 fallback paths.

## Phase 5: Orchestrator

- [x] 5.1 RED: `src/__tests__/application/messaging/invoice-detail/ReplyWithInvoiceDetail.test.ts` — trigger+invoices → one `sendMessage`; no phone match → no send; reader throws → GR-lookup-fails fallback sent, no rethrow; use in-memory reader (3.4) + fake `ChatwootGateway`. (Also triangulated: unrelated content never fires; stale-balance refresh success continues to a real read; stale-after-refresh falls back exactly like a lookup failure.)
- [x] 5.2 GREEN: Create `src/application/use-cases/messaging/invoice-detail/ReplyWithInvoiceDetail.ts` — `isInvoiceDetailTrigger` → `toWhatsAppE164` → `CampaignSegmentSource` → clientId → `RefreshClientBalanceIfStale` (if stale) → `InvoiceDetailReader.listOpenByClientId` (GR API access reused INDIRECTLY, through `RefreshClientBalanceIfStale` → `GestionRealClient`, never called directly) → `renderInvoiceDetailReply` → `ChatwootGateway.sendMessage`; try/catch, never throws. Zero imports from `assistant/*`, never reads `ai-assistant-enabled`.

## Phase 6: Webhook wiring

- [x] 6.1 RED: `src/__tests__/application/messaging/ReceiveChatwootWebhook.invoiceDetail.test.ts` (mirrors `ReceiveChatwootWebhook.optout.test.ts` coverage) — inbound tap invokes the collaborator with content/phone/chatwootConversationId; outbound never invokes it; collaborator throwing still acks 200 and still mirrors the message; absent collaborator = zero regression.
- [x] 6.2 GREEN: `src/application/use-cases/messaging/ReceiveChatwootWebhook.ts` — 9th optional ctor arg (the constructor already had 8 params including `assistant` before this change; `invoiceDetailReplier` is appended as the 9th, task doc said "8th" based on stale param count) + `maybeReplyWithInvoiceDetail`, modeled on `maybeRegisterOptOut` (byte-for-byte fail-open try/catch pattern), gated to `direction === 'inbound'`, called last (after the assistant branch).

## Phase 7: Composition + integration

- [x] 7.1 RED: supertest integration test over the Express app, in-memory repos — inbound tap through the full webhook route sends the reply; collaborator absence = zero regression. (Extended the existing `messaging.routes.test.ts` harness with an optional `invoiceDetailReplier` — same pattern as its other optional collaborators — instead of duplicating its ~150-line route-wiring harness in a new file.)
- [x] 7.2 GREEN: `src/infrastructure/http/app.ts` — wire `PrismaInvoiceDetailReader` + `ReplyWithInvoiceDetail` as the 9th ctor arg to `ReceiveChatwootWebhook` (actual current arg count, see 6.2 note), guarded on `balanceRefresh` being defined (GR configured) since the orchestrator requires a non-optional `RefreshClientBalanceIfStale`.

## Phase 8: Regression + cleanup

- [x] 8.1 Run `npm test` full suite — confirm zero regression on the CTA-only path and all existing template/webhook tests. (Full suite green: 1290 suites passed / 6 skipped, 13675 tests passed / 88 skipped; `npx tsc --noEmit` clean.)
- [x] 8.2 Confirm spec text (0.2) matches shipped behavior before archive. (QR-4 scenario body was already reconciled by 0.2; its requirement HEADING still said "no reply … or internal error", contradicting the scenario — heading reworded to "fail-open; owner-locked fallback reply on internal error, no reply on unresolved phone". Also closed the two verification gaps `sdd-verify` flagged: TPL-3's explicit `type:'url'` scenario and TPL-6's recategorization scenario now have real tests.)
