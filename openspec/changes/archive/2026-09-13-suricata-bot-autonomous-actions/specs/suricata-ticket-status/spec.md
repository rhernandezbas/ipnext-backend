# suricata-ticket-status Specification

## Purpose

A zero-checkpoint external action that changes a ticket's status on BOTH sides: the Prominense mirror and real Suricata, via the bulk-actions "Cambiar Estado" modal. Token-authenticated, flag-gated, and audited exactly like `suricata-ticket-close`.

**Known gap — blocking prerequisite**: same caveat as `suricata-ticket-close` — the exact DOM selectors for the "Cambiar Estado" modal are UNVERIFIED as of this spec. This spec defines REQUIRED BEHAVIOR and the port/interface contract only; concrete selectors are an explicit apply-time discovery task, never invented here.

**Non-goal**: assignment, priority and area write-back stay Prominense-only and are not touched by status change.

## Requirements

### Requirement: STATUS-1 — token authentication, dark by default

The route MUST require the same external API key as the other three write routes and MUST gate on its own `suricata-bot-status-enabled` flag, independent of reply/close/note. Missing key or disabled flag MUST fail closed before any driver call.

#### Scenario: flag off blocks status change

- GIVEN `suricata-bot-status-enabled` is `false`
- WHEN a validly authenticated status-change request arrives
- THEN it responds 403 `FEATURE_DISABLED`, no mirror update and no Suricata call occur

### Requirement: STATUS-2 — target status must be a valid catalog value

The request body MUST include a target status value drawn from Suricata's known status catalog. An unrecognized or empty value MUST be rejected with 400 before any side effect.

#### Scenario: invalid status value

- GIVEN a status-change request with an unrecognized status string
- WHEN it is validated
- THEN it responds 400, neither Suricata nor the mirror is modified

### Requirement: STATUS-3 — ticket must exist in the mirror

A status-change request for a ticket id not present in the mirror MUST respond 404 without any side effect.

#### Scenario: unknown ticket id

- GIVEN a ticket id absent from the mirror
- WHEN a status change is requested for it
- THEN it responds 404, no audit row of outcome "success" is created

### Requirement: STATUS-4 — real Suricata status change via a dedicated port

A validated, enabled status change MUST invoke a new domain port (e.g. `SuricataTicketStatusDriver`, exposing a `setStatus(externalId, status)`-shaped contract) through `SuricataSession.withSession` with `priority: 'high'`, driving Suricata's real "Cambiar Estado" bulk action. Concrete DOM selectors are an explicit apply-time discovery task.

#### Scenario: successful status change reaches real Suricata

- GIVEN a validated, enabled request changing status to "En proceso"
- WHEN the use case executes successfully
- THEN the ticket's status in real Suricata reflects "En proceso"
- AND the session was acquired with `high` priority through the shared `SuricataSession`, never a second browser context

### Requirement: STATUS-5 — Suricata write first, mirror after

The mirror's status field MUST be updated only after the real Suricata status change succeeds. If the Suricata-side write fails, the mirror MUST NOT be changed.

#### Scenario: Suricata status change fails, mirror stays unchanged

- GIVEN a status-change attempt where the real Suricata write fails
- WHEN the use case completes
- THEN the mirror ticket's status is unchanged and the caller receives a non-success response

### Requirement: STATUS-6 — audited via the unified bot-action audit

Every status-change attempt, successful or failed, MUST produce exactly one record in `suricata-bot-action-audit` with action type `status`, the exact target status value, the machine actor, a timestamp, and an outcome.

#### Scenario: failed status change is still audited

- GIVEN a status-change attempt that fails against real Suricata
- WHEN the use case completes
- THEN an audit record exists with action type `status` and outcome `failed`

### Requirement: STATUS-7 — auto-sync selection handling

The driver MUST handle Suricata's periodic auto-sync redrawing the ticket table and clearing checkbox selection during the status-change flow, the same way a human operator does, so a mid-flow redraw MUST NOT silently apply the status to the wrong ticket or no ticket.

#### Scenario: auto-sync fires mid-flow

- GIVEN the driver is mid-flow when Suricata's table auto-sync redraws
- WHEN the status-change action proceeds
- THEN it re-establishes the correct row selection before confirming, or fails closed rather than acting on a stale/wrong selection
