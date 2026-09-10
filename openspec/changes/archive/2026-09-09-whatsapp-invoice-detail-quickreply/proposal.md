# Proposal: WhatsApp invoice-detail quick-reply

## Intent

Customers asking for their invoices today wait for a human. A WhatsApp template quick-reply button ("Ver mis facturas") should trigger an automatic, deterministic (no AI/LLM) reply in the same Chatwoot thread listing that customer's real pending Gestión Real invoices: number, due date, balance, and per-invoice links. This is a NEW change, separate from the already-merged `whatsapp-template-buttons` (URL/CTA button, generates no reply); it needs its own worktree/branch at apply.

## Scope

### In Scope
- Widen `TemplateButton` / `CreateTemplateInput.button` into a discriminated union (`url` | `quickReply`) without breaking the shipped CTA path.
- Add a `twilio/quick-reply` creation branch to `TwilioContentGateway.createTemplate()` and the in-memory fake.
- New deterministic inbound branch in `ReceiveChatwootWebhook` modeled on `maybeRegisterOptOut`: optional collaborator, fail-open, no AI.
- New isolated module: phone→Client resolution, GR invoice read, pure formatter (itemized blocks + divider, "Ver", "Pagar ahora", conditional post-due line), send via existing reply path.
- Tests: in-memory port + supertest, per project TDD convention.

### Out of Scope
- Any edit to, or import from, `application/use-cases/assistant/*` or `adapters/assistant/*` (owner-parked feature).
- Touching or reading the `ai-assistant-enabled` flag anywhere.
- Building or changing the GR client itself (`GestionRealClient` already parses `GrInvoice[]`).
- Multi-button templates, free-text invoice queries, portal/payment changes.

## Capabilities

### New Capabilities
- `whatsapp-invoice-detail-quickreply`: quick-reply button tap → deterministic pending-invoice detail reply in the same conversation.

### Modified Capabilities
- `external-bulk-messaging`: template creation must accept a quick-reply button variant alongside the existing CTA-URL button.

## Approach

**Approach B — full isolation** (owner-locked). Duplicate the ~100 lines of GR-lookup/render glue into a brand-new module with ZERO imports from the parked assistant. Two independent layers: (1) template-creation support for quick-reply buttons; (2) an inbound webhook branch that detects the tap and sends the rendered invoice block. Trade-off accepted: two copies of render logic, in exchange for zero risk to the parked feature and free divergence of copy/tone.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/domain/ports/TemplateMessagingPort.ts` | Modified | Button shape → discriminated union |
| `src/infrastructure/adapters/twilio/TwilioContentGateway.ts` | Modified | `twilio/quick-reply` create branch |
| `src/infrastructure/adapters/in-memory/InMemoryTemplateMessagingGateway.ts` | Modified | Mirror the new branch in the fake |
| `src/application/use-cases/messaging/ReceiveChatwootWebhook.ts` | Modified | New fail-open inbound branch |
| `src/application/use-cases/messaging/invoice-detail/*` (new) | New | Resolver + pure formatter, isolated |
| `src/__tests__/**` | New | Use-case + route coverage |

## Open Questions for `sdd-design`

1. **Tap detection.** Matching the button's display TITLE is fragile (a later title edit silently kills the feature — same class as `feature-sin-perilla-inerte`). Design must inspect a REAL inbound Twilio/Chatwoot payload for a stable button id/payload distinct from the title, and only fall back to title matching if no such field exists. Do not assume.
2. **Quick-reply → auto-reply mechanism unverified.** The tap-generates-an-inbound-message behavior was inferred from docs/architecture, not observed in this repo. Design or tasks must verify it against an actual payload and/or a live smoke plan before implementation is certified.
3. **"Pagar luego del vencimiento".** `GrInvoice` exposes `urlPdf`, `cuponPdf`, and a single `paymentUrl` (MercadoPago, from `payments_url.MercadoPago`) — there is no distinct post-due link field. Design must decide whether `cuponPdf` is the post-due instrument or whether the third line is cosmetic wording over the same `paymentUrl` (and whether to omit it entirely).

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Quick-reply auto-reply mechanism does not behave as assumed | Med | Verify payload before implementing; spike first task |
| Title-based matching silently stops firing | Med | Prefer stable button id; assert trigger in tests |
| Union widening breaks shipped CTA path | Low | Discriminated union + existing CTA tests stay green |
| Duplicated render logic drifts from assistant copy | Low | Accepted by owner decision; isolated module documents intent |
| Sending invoice data to a mis-resolved phone (PII) | Low | Reuse proven `toWhatsAppE164` + Client lookup; no match → no reply |

## Rollback Plan

Revert the feature branch. The webhook branch is an optional constructor collaborator — omitting it restores prior behavior with no schema or data migration. Quick-reply templates already created in Twilio remain but simply stop producing replies.

## Dependencies

- Twilio Content API quick-reply support (external, unverified in-repo).
- Existing GR mirror refresh lane and Chatwoot reply path.
- New worktree/branch (not `whatsapp-template-buttons`).

## Success Criteria

- [ ] A quick-reply template can be created through the existing template API.
- [ ] A real tap produces one automatic reply listing the customer's pending GR invoices.
- [ ] Reply format matches the itemized/divider layout with per-invoice links.
- [ ] Zero imports from `assistant/*`; zero references to `ai-assistant-enabled`.
- [ ] Unknown/unmatched inbound content is unaffected; webhook still acks 200 on failure.
