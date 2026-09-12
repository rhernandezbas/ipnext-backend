# suricata-ticket-reply Specification

## Purpose

A guarded action that sends a REAL reply into a Suricata conversation, driven by the same server-side Playwright session used for sync. This is irreversible and visible to a real customer, so it is gated by RBAC and by explicit double confirmation, and every attempt is audited regardless of outcome.

## Requirements

### Requirement: REPLY-1 — RBAC-gated action

Triggering a reply MUST require a dedicated, high-risk permission distinct from read-only panel access (module `suricata`, action `reply`). A caller without that permission MUST be rejected before any Playwright interaction starts.

#### Scenario: caller without reply permission

- GIVEN a user with `suricata.read` but not `suricata.reply`
- WHEN they attempt to trigger a reply
- THEN the request is rejected and no Playwright session action occurs

### Requirement: REPLY-2 — explicit double confirmation required

The action MUST NOT execute unless the caller has passed through two distinct, explicit confirmation steps in the UI. A single confirmation, or a request without confirmation evidence, MUST be rejected.

#### Scenario: single confirmation is not enough

- GIVEN a reply request with only one confirmation flag present
- WHEN it reaches the backend
- THEN it is rejected, no message is sent, and no audit entry with outcome "success" is created

#### Scenario: both confirmations present

- GIVEN a reply request carrying both required confirmation signals and a non-empty message text
- WHEN it is submitted
- THEN the send proceeds

### Requirement: REPLY-3 — real delivery into Suricata

A confirmed reply MUST perform the actual flow against Suricata: navigate to the ticket, enter the conversation, type the exact confirmed text, and send it. The message MUST appear in the real Suricata conversation thread.

#### Scenario: confirmed reply is delivered

- GIVEN a confirmed reply with text "Ya revisamos tu reclamo"
- WHEN the action runs successfully
- THEN that exact text appears in the ticket's conversation in Suricata

### Requirement: REPLY-4 — full audit trail on every attempt

Every attempt — successful or failed — MUST persist a record with: the confirming actor, the ticket, the exact text sent, a timestamp, and the outcome (success/error). This MUST happen even when the send fails.

#### Scenario: successful send is audited

- GIVEN a reply that is sent successfully
- WHEN the action completes
- THEN an audit record exists with actor, ticket, text, timestamp and outcome "success"

#### Scenario: failed send is still audited

- GIVEN a reply attempt that fails mid-flow (e.g., Suricata session error)
- WHEN the action completes
- THEN an audit record exists with outcome "error", and the panel does not report success

### Requirement: REPLY-5 — no silent failure

A failed send MUST surface the error to the caller/UI. The system MUST NOT report success when the message was not actually delivered.

#### Scenario: error surfaces to the caller

- GIVEN a reply attempt that fails
- WHEN the caller receives the response
- THEN the response indicates failure, not success

### Requirement: REPLY-6 — scoped to reply only

This action MUST NOT modify status, priority, area or assignment on Suricata's side; it only sends the message.

#### Scenario: reply does not touch other fields

- GIVEN a successful reply
- WHEN reviewing what changed on Suricata's side
- THEN only the conversation gained the new message — no other ticket field changed
