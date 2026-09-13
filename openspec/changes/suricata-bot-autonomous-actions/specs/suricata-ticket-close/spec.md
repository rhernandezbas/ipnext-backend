# suricata-ticket-close Specification

## Purpose

A zero-checkpoint external action that closes a ticket in real Suricata via the bulk-actions "Cerrar seleccionados" modal (including its close-reason field). It writes no field on the Prominense mirror — see CLOSE-5's 2026-09-13 correction; the mirror reconciles on its own sync tick. It is token-authenticated, flag-gated, and audited exactly like `suricata-external-reply`.

**Known gap — blocking prerequisite**: the exact DOM selectors for the "Cerrar seleccionados" modal and its close-reason field are UNVERIFIED as of this spec. `selectors.ts` was live-verified 2026-09-13 only for login, ticket list and ticket detail — never for the bulk-actions modal. This spec defines the REQUIRED BEHAVIOR and the port/interface contract; it deliberately does NOT invent selector strings. A live authenticated Playwright verification pass against the real Suricata site is a prerequisite task before this capability can be implemented for real, the same caveat the original ticket-mirror scraper selectors carried before their 2026-09-13 verification.

**Non-goal**: assignment, priority and area write-back stay Prominense-only and are not touched by close.

## Requirements

### Requirement: CLOSE-1 — token authentication, dark by default

The route MUST require the same external API key as the reply/verdict routes and MUST gate on its own `suricata-bot-close-enabled` flag, independent of the other three action flags. Missing key or disabled flag MUST fail closed before any driver call.

#### Scenario: flag off blocks close

- GIVEN `suricata-bot-close-enabled` is `false`
- WHEN a validly authenticated close request arrives
- THEN it responds 403 `FEATURE_DISABLED`, no mirror update and no Suricata call occur

### Requirement: CLOSE-2 — close reason required

The request body MUST include a non-empty close reason. A request without one MUST be rejected with 400 before any side effect.

#### Scenario: missing close reason

- GIVEN a close request with no reason text
- WHEN it is validated
- THEN it responds 400, neither Suricata nor the mirror is modified

### Requirement: CLOSE-3 — ticket must exist in the mirror

A close request for a ticket id not present in the mirror MUST respond 404 without any side effect.

#### Scenario: unknown ticket id

- GIVEN a ticket id absent from the mirror
- WHEN a close is requested for it
- THEN it responds 404, no audit row of outcome "success" is created

### Requirement: CLOSE-4 — real Suricata close via a dedicated port

A validated, enabled close MUST invoke a new domain port (e.g. `SuricataTicketCloseDriver`, exposing a `close(externalId, reason)`-shaped contract) through `SuricataSession.withSession` with `priority: 'high'`, driving Suricata's real "Cerrar seleccionados" bulk action with the submitted reason. The concrete CSS/DOM selectors are an explicit apply-time discovery task, not part of this spec.

#### Scenario: successful close reaches real Suricata

- GIVEN a validated, enabled close request with reason "Reclamo resuelto"
- WHEN the use case executes successfully
- THEN the ticket is closed in real Suricata with that reason
- AND the session was acquired with `high` priority through the shared `SuricataSession`, never a second browser context

### Requirement: CLOSE-5 — audit-only locally; close never writes the mirror

CORRECTED 2026-09-13 (design D5.a, after the live capture pass). This requirement was originally written on the assumption that closing is a status transition and that the mirror's `status` is set to a closed value. That assumption is wrong: Suricata's close is its OWN action, independent of the "Cambiar Estado" catalog, and that catalog contains no closed value at all.

`CloseSuricataTicket` MUST therefore write NO field on the local `SuricataTicket` mirror — not on success and not on failure. The only local write a close produces is its `suricata-bot-action-audit` row (CLOSE-6). The mirror's own close-adjacent fields reconcile on the next read-side sync tick, per the established ordering rule that the mirror write is a latency optimization and never a source of truth (design D5). A failed remote close MUST still surface to the caller as a non-success response, so a failure is never hidden as a success.

#### Scenario: successful close leaves the mirror ticket untouched

- GIVEN a validated, enabled close that succeeds against real Suricata
- WHEN the use case completes
- THEN no field of the mirror ticket is modified, and the only local trace of the action is its audit row

#### Scenario: Suricata close fails, mirror stays unchanged

- GIVEN a close attempt where the real Suricata write fails
- WHEN the use case completes
- THEN the mirror ticket is unchanged and the caller receives a non-success response

### Requirement: CLOSE-6 — audited via the unified bot-action audit

Every close attempt, successful or failed, MUST produce exactly one record in `suricata-bot-action-audit` with action type `close`, the exact close reason, the machine actor, a timestamp, and an outcome.

#### Scenario: failed close is still audited

- GIVEN a close attempt that fails against real Suricata
- WHEN the use case completes
- THEN an audit record exists with action type `close` and outcome `failed`

### Requirement: CLOSE-7 — auto-sync selection handling

The driver MUST handle Suricata's periodic auto-sync redrawing the ticket table and clearing checkbox selection during the close flow, the same way a human operator does (e.g., re-select before confirming), so a mid-flow redraw MUST NOT silently close the wrong ticket or no ticket.

#### Scenario: auto-sync fires mid-close

- GIVEN the driver is mid-flow when Suricata's table auto-sync redraws
- WHEN the close action proceeds
- THEN it re-establishes the correct row selection before confirming, or fails closed rather than acting on a stale/wrong selection
