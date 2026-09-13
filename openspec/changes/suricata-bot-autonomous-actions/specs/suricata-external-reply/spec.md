# suricata-external-reply Specification

## Purpose

A zero-checkpoint external path that sends a REAL message into a Suricata conversation, driven by the token-authenticated external API instead of a human session. It is a NEW use case, structurally separate from the internal, RBAC-gated, double-confirmed `ReplyToSuricataTicket` flow (`suricata-ticket-reply`), which is untouched. There is no sha256 `confirm` mechanism here — `confirm` exists to make a human re-confirm their own intent, which is meaningless when the caller is the bot itself.

**Non-goal**: the internal session-gated reply route, its RBAC permission, and its double-confirmation requirement are unchanged and out of scope.

## Requirements

### Requirement: EXTREPLY-1 — token authentication, no session/RBAC

The route MUST be reachable only through the existing external API key mechanism (`config.suricata.externalApiKey`, same constant-time comparison as the verdict route) and MUST NOT require a session cookie or an RBAC permission check.

#### Scenario: missing or wrong external key

- GIVEN a reply request with no key or an incorrect key
- WHEN it reaches the route
- THEN it responds 401 and no Playwright interaction, audit row, or driver call occurs

### Requirement: EXTREPLY-2 — dark by default, independently switchable

The route MUST check the `suricata-bot-reply-enabled` feature flag on every request and MUST fail closed (403, code `FEATURE_DISABLED`) when the flag is missing, unreadable, or `false`. This flag is independent of `suricata-bot-close-enabled`, `suricata-bot-status-enabled`, and `suricata-bot-note-enabled`. The `-bot-` infix is load-bearing (design D2): this route MUST NOT read the pre-existing `suricata-reply-enabled` flag, which governs the INTERNAL human-facing reply route only.

#### Scenario: flag off

- GIVEN `suricata-bot-reply-enabled` is `false`
- WHEN a validly authenticated request arrives
- THEN it responds 403 with `FEATURE_DISABLED`, no driver call and no audit row are produced

#### Scenario: reply flag on, close flag off does not affect reply

- GIVEN `suricata-bot-reply-enabled` is `true` and `suricata-bot-close-enabled` is `false`
- WHEN a reply request arrives
- THEN it proceeds to validation/execution — the close flag has no bearing on this route

### Requirement: EXTREPLY-3 — no confirmation mechanism

The request body MUST require only a ticket identifier and a non-empty message text. The route MUST NOT accept, require, or validate a `confirm` field or any sha256-based double-confirmation signal.

#### Scenario: request with only ticket id and text succeeds validation

- GIVEN `{ body: "Ya revisamos tu reclamo" }` for a known ticket, with no `confirm` field
- WHEN it is validated
- THEN it passes validation and proceeds to execution

#### Scenario: empty text rejected

- GIVEN a request with an empty or missing `body`
- WHEN it is validated
- THEN it responds 400 before any driver call or audit row

### Requirement: EXTREPLY-4 — real delivery via the Botpress HTTP actuator

**Corrected 2026-09-13** (live end-to-end verification superseded the original assumption below, kept struck through for the record):

> ~~A validated, enabled reply MUST invoke `PlaywrightSuricataReply` (wired for the external
> composition only) through `SuricataSession.withSession` with `priority: 'high'`.~~

The real conversation thread renders inside a cross-origin, websocket-driven iframe
(`conversation.suricata.chat`) that a Playwright `fill`/`type` cannot reliably reach —
`PlaywrightSuricataReply`/`SuricataReplySession` remain unimplemented for reply and are NOT used. A
validated, enabled reply MUST instead invoke `BotpressReplyPort.sendReply` (`BotpressReplyAdapter`, a
plain HTTP client — no `SuricataSession`, no browser, no priority queue slot). It resolves the
ticket's `conversationId` via the same `metadata-ticket` lookup `botpressMessages.ts` already uses for
reading, then `POST https://api.botpress.cloud/v1/chat/messages` with the Botpress PAT/`bot_id`
resolved from `metadata-merchant`. On success, the exact submitted text MUST appear in the ticket's
real Suricata/WhatsApp conversation — verified live 2026-09-13 against a real test ticket, received on
a real WhatsApp number.

#### Scenario: successful autonomous reply

- GIVEN a validated, enabled reply request with text "Ya revisamos tu reclamo"
- WHEN the use case executes successfully
- THEN that exact text appears in the ticket's conversation in real Suricata/WhatsApp
- AND the call went through `BotpressReplyPort` only — no `SuricataSession`, no Playwright browser
  context, no priority queue slot was acquired

### Requirement: EXTREPLY-5 — audited via the unified bot-action audit

Every attempt, successful or failed, MUST produce exactly one record in the unified bot-action audit (`suricata-bot-action-audit`) with action type `reply`, the exact submitted text, the machine actor, a timestamp, and an outcome — written before or alongside the driver call, per `suricata-bot-action-audit` EXTAUDIT-1.

#### Scenario: failed send is still audited

- GIVEN a reply attempt that fails mid-flow (e.g., session busy)
- WHEN the use case completes
- THEN an audit record exists with action type `reply` and outcome `failed`, and the caller receives a non-success response

### Requirement: EXTREPLY-6 — machine actor identity

The route MUST run behind `machineActorMiddleware` resolving `API_SURICATA_USER_LOGIN`, so the audit record's actor is that real machine `RbacUser`, never `anonymous` and never a human identity.

#### Scenario: actor recorded is the machine user

- GIVEN a successful autonomous reply
- WHEN the audit record is inspected
- THEN its actor matches the `RbacUser` for `API_SURICATA_USER_LOGIN`
