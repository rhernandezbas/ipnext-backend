# suricata-internal-note Specification

## Purpose

A zero-checkpoint external action that posts an INTERNAL note on a Suricata ticket — visible to agents, never to the customer — via Suricata's `#internalNoteComentario` field and "Crear" mechanism, as documented by the manual `atencion-suricata-ipnext` skill. Token-authenticated, flag-gated, and audited like the other three write actions. Unlike reply/close/status, a note has no customer-visible side effect, but it still MUST go through the same audit and flag discipline.

**Known gap — blocking prerequisite**: the `#internalNoteComentario`/"Crear" selector path is documented by the skill for a HUMAN clicking through the UI, but it has NOT been live-verified for Playwright automation as of this spec (same status as close/status). This spec defines REQUIRED BEHAVIOR and the port/interface contract only; concrete selectors are an explicit apply-time discovery task, never invented here.

**Non-goal**: this action never touches status, priority, area, assignment or the customer-visible conversation.

## Requirements

### Requirement: NOTE-1 — token authentication, dark by default

The route MUST require the same external API key as the other three write routes and MUST gate on its own `suricata-external-note-enabled` flag, independent of reply/close/status. Missing key or disabled flag MUST fail closed before any driver call.

#### Scenario: flag off blocks note posting

- GIVEN `suricata-external-note-enabled` is `false`
- WHEN a validly authenticated note request arrives
- THEN it responds 403 `FEATURE_DISABLED`, no Suricata call occurs

### Requirement: NOTE-2 — non-empty note text required

The request body MUST include non-empty note text. A request without one MUST be rejected with 400 before any side effect.

#### Scenario: empty note text

- GIVEN a note request with empty or missing text
- WHEN it is validated
- THEN it responds 400, no Suricata call and no audit row are produced

### Requirement: NOTE-3 — ticket must exist in the mirror

A note request for a ticket id not present in the mirror MUST respond 404 without any side effect.

#### Scenario: unknown ticket id

- GIVEN a ticket id absent from the mirror
- WHEN a note is requested for it
- THEN it responds 404, no audit row of outcome "success" is created

### Requirement: NOTE-4 — real Suricata note via a dedicated port

A validated, enabled note request MUST invoke a new domain port (e.g. `SuricataInternalNoteDriver`, exposing a `postNote(externalId, text)`-shaped contract) through `SuricataSession.withSession` with `priority: 'high'`, driving Suricata's internal-note field and "Crear" action. Concrete DOM selectors are an explicit apply-time discovery task.

#### Scenario: successful note reaches real Suricata

- GIVEN a validated, enabled note request with text "Escalado a NOC"
- WHEN the use case executes successfully
- THEN that exact text appears as an internal note on the ticket in real Suricata
- AND the session was acquired with `high` priority through the shared `SuricataSession`, never a second browser context

### Requirement: NOTE-5 — scoped to internal note only

A note action MUST NOT modify status, priority, area, assignment, or the customer-visible conversation on Suricata's side.

#### Scenario: note does not touch other fields

- GIVEN a successful internal note posting
- WHEN reviewing what changed on Suricata's side
- THEN only the internal notes panel gained the new entry — no other ticket field changed

### Requirement: NOTE-6 — audited via the unified bot-action audit

Every note attempt, successful or failed, MUST produce exactly one record in `suricata-bot-action-audit` with action type `note`, the exact note text, the machine actor, a timestamp, and an outcome.

#### Scenario: failed note posting is still audited

- GIVEN a note attempt that fails against real Suricata
- WHEN the use case completes
- THEN an audit record exists with action type `note` and outcome `failed`

### Requirement: NOTE-7 — auto-sync handling

The driver MUST handle Suricata's periodic auto-sync during the note flow the same way a human operator does, so a mid-flow redraw MUST NOT cause the note to be posted on the wrong ticket.

#### Scenario: auto-sync fires mid-flow

- GIVEN the driver is mid-flow when Suricata's table auto-sync redraws
- WHEN the note action proceeds
- THEN it re-confirms it is still operating on the correct ticket before submitting, or fails closed rather than posting on a stale/wrong ticket
