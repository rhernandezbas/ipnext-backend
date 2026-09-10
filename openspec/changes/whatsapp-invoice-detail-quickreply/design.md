# Design: WhatsApp invoice-detail quick-reply

## Technical Approach

Two independent layers, per the owner-locked **Approach B (full isolation)**:

1. **Creation** — widen `TemplateButton` into a tagged union and add a third branch to `TwilioContentGateway.createTemplate()`.
2. **Inbound** — a new fail-open branch in `ReceiveChatwootWebhook`, modeled byte-for-byte on `maybeRegisterOptOut` (`ReceiveChatwootWebhook.ts:537-573`): optional constructor collaborator, try/catch, never throws, webhook always acks 200.

The new module (`application/use-cases/messaging/invoice-detail/`) **imports nothing from `assistant/*`** and never reads `ai-assistant-enabled`. It re-implements the mirror read and the render, using `PrismaAssistantInvoicesReader.ts` and `renderInvoiceBlock.ts` only as reference. Shared, non-assistant collaborators (`CustomerRepository`, `RefreshClientBalanceIfStale`, `CampaignSegmentSource`, `toWhatsAppE164`, `ChatwootGateway`, `GestionRealClient`) are reused, not duplicated.

## Architecture Decisions

### Decision: tagged union with normalization at the validation boundary

**Choice**: domain type is always tagged; the HTTP DTO stays untagged and `CreateTemplate.assertValidButton` normalizes a missing `type` to `'url'`.

```ts
export type TemplateButton =
  | { type: 'url'; title: string; url: string }
  | { type: 'quickReply'; title: string };
```

**Alternatives**: require an explicit `type` on the wire (breaks the CTA path already in production today); make `type` optional in the domain type (adapter `switch` stops being exhaustive).
**Rationale**: existing callers posting `{title, url}` keep working unchanged; the adapter still gets an exhaustive discriminant. Backward compatibility lives in the one place validation already lives (`CreateTemplate.ts:25-70`), not scattered across adapters.

### Decision: detect the tap by exact button title, and make drift impossible at creation

**Choice**: `INVOICE_DETAIL_BUTTON_TITLE` is a single exported constant. Detection is trim + case-insensitive **exact** equality (same discipline as `OPT_OUT_KEYWORDS`, never substring). `assertValidButton` **rejects** a `quickReply` button whose title is not that constant.

**Alternatives**: match a button id/payload — **impossible**; a live experiment proved a `twilio/quick-reply` tap arrives as an ordinary inbound message (`message_type=0`, `content` = the button title verbatim, `content_attributes` empty). No id reaches us.
**Rationale**: title matching is forced by the wire, so the fragility is moved to where it can be eliminated: an operator physically cannot create a quick-reply template whose title the webhook would not recognize. This is the anti-drift answer to the previous change's review finding, not a repeat of it.

### Decision: set an inert `id` on the Twilio action

**Choice**: emit `actions: [{ id: slug(title), title }]`, slug computed inside the gateway (lowercase, non-alphanumeric → `_`).
**Alternatives**: omit `id`; add an `id` field to `CreateTemplateInput`.
**Rationale**: Twilio expects an id at creation; it is write-only from our webhook's perspective today. A derived slug costs zero API surface and leaves Twilio-side bookkeeping meaningful if Chatwoot ever surfaces payloads.

### Decision: no "pagar luego del vencimiento" line in v1

**Choice**: render `Ver` (`urlPdf`) and `Pagar ahora` (`paymentUrl`) only.
**Rationale**: `GrInvoice` has no post-due field. `cuponPdf` is a coupon PDF, not a post-due link; labeling the same `paymentUrl` twice would assert something about money we have not verified.

### Decision: fallbacks always answer, and never claim "al día"

**Choice**: mirror stale / GR unreachable / reader throws → one apologetic message plus handoff to a person. Zero open invoices → a neutral "no encuentro facturas pendientes para mostrarte, lo confirmamos con una persona".
**Rationale**: silence on a customer-facing tap is the worst outcome; an empty mirror is indistinguishable from "owes nothing", and only the balance source may assert that (same trap `ClienteFacturasResolver` documents).

## Data Flow

    tap → Twilio → Chatwoot → webhook (message_created, inbound)
      │
      ├─ existing: maybeRegisterOptOut / mirror the message   (unchanged)
      └─ NEW maybeReplyWithInvoiceDetail (fail-open, last)
             isInvoiceDetailTrigger(content)
                → toWhatsAppE164(phone) → CampaignSegmentSource → clientId
                → RefreshClientBalanceIfStale (if stale)
                → InvoiceDetailReader.listOpenByClientId
                → renderInvoiceDetailReply (pure)
                → ChatwootGateway.sendMessage(conversationId, text)

Free text inside the just-opened 24h window — not a template.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/domain/ports/TemplateMessagingPort.ts` | Modify | `TemplateButton` → tagged union |
| `src/application/dto/messaging-templates.dto.ts` | Modify | `button?: { type?: unknown; title?: unknown; url?: unknown }` |
| `src/application/use-cases/messaging/CreateTemplate.ts` | Modify | Normalize missing `type`→`url`; validate `quickReply` title against the constant |
| `src/infrastructure/adapters/twilio/TwilioContentGateway.ts` | Modify | Three-way `types` branch (`twilio/text` / `call-to-action` / `quick-reply`) |
| `src/infrastructure/adapters/in-memory/InMemoryTemplateMessagingGateway.ts` | Modify | Mirror the branch in the fake |
| `.../messaging/invoice-detail/invoiceDetailButton.ts` | Create | `INVOICE_DETAIL_BUTTON_TITLE` + `isInvoiceDetailTrigger` (shared constant) |
| `.../messaging/invoice-detail/renderInvoiceDetailReply.ts` | Create | Pure formatter (itemized blocks, divider, fallbacks) |
| `.../messaging/invoice-detail/ReplyWithInvoiceDetail.ts` | Create | Resolver/orchestrator, never throws |
| `src/domain/ports/InvoiceDetailReader.ts` | Create | Narrow port; explicit `select`, no PII columns |
| `src/infrastructure/adapters/prisma/PrismaInvoiceDetailReader.ts` | Create | Mirror read (`status in ['pendiente','vencida']`, `orderBy dueDate asc`) |
| `src/infrastructure/adapters/in-memory/InMemoryInvoiceDetailReader.ts` | Create | Test double |
| `src/application/use-cases/messaging/ReceiveChatwootWebhook.ts` | Modify | 8th optional ctor arg + `maybeReplyWithInvoiceDetail` |
| `src/infrastructure/http/app.ts` | Modify | Wire the new collaborator |
| `src/__tests__/**` | Create | See Testing Strategy |

## Interfaces / Contracts

```ts
export const INVOICE_DETAIL_BUTTON_TITLE = 'Ver mis facturas';

export interface InvoiceDetailInvoice {
  tipo: string; numero: string; vencimiento: string; saldo: number;
  pdfUrl: string | null; paymentUrl: string | null;
}
export interface InvoiceDetailReader {
  listOpenByClientId(clientId: string): Promise<InvoiceDetailInvoice[]>;
}
```

## Testing Strategy (Strict TDD — RED first, every row)

| Layer | What to Test | Approach |
|-------|--------------|----------|
| Unit (gateway) | Three-way branch: no button → `twilio/text`; `type:'url'` → `call-to-action` (existing tests must stay green); `type:'quickReply'` → `twilio/quick-reply` with `actions[0].id/title` | Injected axios stub, assert the posted JSON |
| Unit (validation) | Untagged `{title,url}` still accepted as `url`; `quickReply` without `url` accepted; `quickReply` with a foreign title rejected 400; `url` arm keeps all existing url rules | `CreateTemplate` direct |
| Unit (formatter) | Pure: N invoices → itemized text; omits `Pagar ahora` when `paymentUrl` null; empty → neutral message that never says "al día"; failure → apologetic + handoff | Table-driven, no doubles |
| Unit (trigger) | Exact/case-insensitive/trim match; substring (`"quiero ver mis facturas"`) does NOT fire | Pure function |
| Unit (use case) | Match + invoices → one `sendMessage`; no phone match → no send; reader throws → fallback sent, no rethrow | In-memory reader + fake gateway |
| Integration (webhook) | Inbound tap sends the reply; unrelated content unaffected; collaborator throwing still acks 200; absent collaborator = zero regression | supertest over the Express app, in-memory repos |

## Threat Matrix

N/A — no shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary. The webhook branch is in-process application dispatch. Its two real hazards are covered by design decisions above: PII misdelivery (canonical E164 exact match, no match ⇒ no reply) and stale financial data (refresh-if-stale, then fallback instead of citing).

## Migration / Rollout

No migration; no schema change; no new env var. The branch is an optional constructor collaborator — omit it in `app.ts` to restore prior behavior exactly. Quick-reply templates already created in Twilio simply stop producing replies.

## Open Questions

- [ ] Meta recategorized our UTILITY-submitted quick-reply template to **MARKETING** on approval (empty `rejection_reason`, `category: MARKETING` in the response). Per the `whatsapp-bulk-ipnext` skill that is ~0.0668 vs ~0.017 USD/msg — roughly **5x per message**. Not blocking for design; must be decided before any volume send.
- [ ] Exact Spanish copy for the two fallback messages (owner's wording).
