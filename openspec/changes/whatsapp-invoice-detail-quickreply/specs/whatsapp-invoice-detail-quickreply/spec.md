# Whatsapp Invoice Detail Quick-Reply Specification

## Purpose

Deterministic, AI-free reply to a WhatsApp quick-reply button tap ("Ver mis facturas") that
lists the tapping customer's pending Gestión Real (GR) invoices in the same Chatwoot
conversation. Fully isolated module (Approach B): zero imports from, and zero reference to the
flag of, the parked `ai-assistant-cobranzas` feature.

## Requirements

### Requirement: QR-1 — trigger detection is title-text match (confirmed, sole available signal)

A real button tap produces a normal INCOMING Chatwoot message: `message_type=0`, `content`
equal verbatim to the tapped button's title, `content_type=0` (plain text), and EMPTY
`content_attributes` — confirmed live against the Chatwoot database; Chatwoot captures no
button id or payload for this interaction. The system MUST detect a tap solely by comparing the
inbound message's trimmed content, case-insensitively, against a fixed, small set of known
button-title constants owned by this feature's own templates, and MUST NOT depend on any
`content_attributes` field or other button metadata, because none is ever populated.

#### Scenario: exact title match triggers the reply
- GIVEN inbound content matching a configured button title (any letter case, leading/trailing
  whitespace)
- WHEN the webhook processes it
- THEN the system treats it as an invoice-detail request

#### Scenario: unrelated content never false-triggers
- GIVEN inbound content that does not match any configured title (including a customer typing
  similar but non-identical text)
- WHEN the webhook processes it
- THEN no invoice-detail reply is sent, and other webhook handling (e.g. opt-out) is unaffected

### Requirement: QR-2 — full isolation from the parked assistant feature

This feature MUST live in new files with ZERO imports from `application/use-cases/assistant/*`
or `adapters/assistant/*`, and MUST NOT read, write, or otherwise reference the
`ai-assistant-enabled` flag anywhere in its code path.

#### Scenario: independent of the assistant flag
- GIVEN `ai-assistant-enabled` is OFF (current production state)
- WHEN a customer taps the invoice-detail quick-reply button
- THEN the reply is still generated and sent — behavior MUST NOT depend on that flag's value

### Requirement: QR-3 — deterministic invoice resolution and reply content

On a detected trigger (QR-1), the system MUST resolve the sender's phone to an existing
`Client` (same E.164 normalization used elsewhere), fetch that client's real pending GR
invoices, and reply as a normal outbound free-text Chatwoot message (NOT a template) into the
currently open session, with one block per invoice containing: número, fecha de vencimiento,
saldo, a "Ver" link (`urlPdf`), and a "Pagar ahora" link (derived from
`payments_url.MercadoPago`). A distinct post-due-date payment instrument/link is OUT OF SCOPE
for this iteration; when a link is shown after the due date it MUST reuse the same payment link
labeled "Pagar", never presented as a separate, dedicated post-due mechanism.

#### Scenario: customer with pending invoices
- GIVEN a resolved Client with pending GR invoices
- WHEN the trigger fires
- THEN the reply lists each invoice with número, fecha de vencimiento, saldo, and both links,
  separated by a divider

#### Scenario: customer with zero pending invoices
- GIVEN a resolved Client with no pending GR invoices
- WHEN the trigger fires
- THEN the system sends a short reply stating there are no pending invoices, and MUST NOT send
  an empty or malformed itemized block

### Requirement: QR-4 — fail-open; no reply on unresolved phone or internal error

The handler MUST be wired as an optional constructor collaborator, wrapped in its own
try/catch, so any internal failure (lookup error, GR client error, malformed data) never breaks
surrounding webhook processing — the webhook MUST still acknowledge 200 regardless. If the
sender's phone does NOT resolve to a known `Client`, the system MUST NOT send any invoice
reply.

#### Scenario: GR lookup fails
- GIVEN a resolved Client whose GR invoice lookup throws
- WHEN the trigger fires
- THEN the system sends the exact owner-locked fallback message ("¡Hola! Por ahora no pudimos
  traer el detalle de tu cuenta. En un rato lo revisamos y te confirmamos por acá. — IPNEXT
  Cobranzas"), the error is not rethrown, and the webhook still responds 200

#### Scenario: phone does not resolve to any Client
- GIVEN an inbound trigger from a phone number with no matching `Client`
- WHEN the webhook processes it
- THEN no reply is sent and no error propagates
