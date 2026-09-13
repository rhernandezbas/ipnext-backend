# suricata-bot-action-audit Specification

## Purpose

ONE unified, append-only audit capability covering all four autonomous write actions (reply, close, status, note) as a single action-type-discriminated record set, molded on `SuricataReplyAudit`'s existing "audit the attempt, not the outcome" pattern (D10). Replaces the idea of four separate per-action tables — "see everything the bot did" is one query, not four.

**Non-goal**: this capability does not decide WHETHER an action runs (flags do); it only guarantees every action that runs is recorded.

## Requirements

### Requirement: EXTAUDIT-1 — non-optional, exactly one record per attempt

Every one of the four write actions (reply, close, status, note) MUST produce exactly one audit record per attempt, regardless of the action's outcome. A use case MUST NOT be able to reach a success or failure response to its caller without a corresponding audit record existing.

#### Scenario: every action type produces a record

- GIVEN one attempt each of reply, close, status and note
- WHEN each completes (success or failure)
- THEN four audit records exist, one per attempt, each carrying its own action type

### Requirement: EXTAUDIT-2 — action-type discriminator with exact content per type

Each record MUST carry an action-type discriminator (`reply` | `close` | `status` | `note`) and the exact content relevant to that type: reply's message body, close's reason, status's target value, or note's text. The schema MUST accommodate these differing shapes (e.g. a JSON payload column or nullable per-type columns) without losing which fields apply to which type.

#### Scenario: content matches the action type

- GIVEN a `close` record with reason "Reclamo resuelto"
- WHEN the record is read back
- THEN its content field(s) contain that reason and no unrelated content field (e.g. a reply body) is populated for that row

### Requirement: EXTAUDIT-3 — attempt recorded before or alongside the Suricata-side effect

The audit record for an attempt MUST exist before or atomically with the call to the Suricata-side driver, so that a driver failure (session busy, auth failure, DOM mismatch) still leaves an auditable trace. The record is written for the ATTEMPT, not conditioned on success — mirroring `SuricataReplyAudit`'s existing pattern.

#### Scenario: audit exists even when the driver call never completes

- GIVEN an attempt where the Suricata session cannot be acquired within its timeout
- WHEN the use case completes
- THEN an audit record exists for that attempt with an outcome indicating failure, even though no real Suricata write occurred

### Requirement: EXTAUDIT-4 — actor identity via the machine actor

Every record MUST carry the actor identity resolved by `machineActorMiddleware` for `API_SURICATA_USER_LOGIN` — the real `RbacUser` behind the external API key — never `anonymous` and never a human session identity.

#### Scenario: actor is the machine user, not anonymous

- GIVEN a successful autonomous action executed through the external API key
- WHEN its audit record is inspected
- THEN the actor field identifies the `RbacUser` for `API_SURICATA_USER_LOGIN`

### Requirement: EXTAUDIT-5 — timestamped and outcome-flipped after the attempt

Each record MUST carry an attempt timestamp. After the Suricata-side call resolves, the record's outcome MUST be updated (outside the initial write's try block) to reflect success or failure, without deleting or replacing the original attempt record.

#### Scenario: outcome flips from pending/attempted to a terminal state

- GIVEN an audit record created at the start of an attempt
- WHEN the Suricata-side call later succeeds
- THEN the same record's outcome is updated to reflect success, preserving its original timestamp and content

### Requirement: EXTAUDIT-6 — append-only, never mutated or deleted

Once an audit record exists, its action type, content, actor and timestamp fields MUST NEVER be altered or deleted by any later action. Only the outcome field MAY transition once from an attempted/pending state to a terminal state (EXTAUDIT-5).

#### Scenario: no deletion path exists

- GIVEN an existing audit record
- WHEN any use case in this capability runs
- THEN no code path deletes that record or modifies its action type, content, actor, or timestamp

### Requirement: EXTAUDIT-7 — queryable across all four action types

The audit MUST be queryable as a single unified set (e.g. by ticket, by actor, by action type, by time range) without needing to union four separate tables.

#### Scenario: querying all actions for a ticket

- GIVEN a ticket with a reply, a close, and a note recorded
- WHEN the audit is queried for that ticket
- THEN all three records are returned from a single query, each identifiable by its action type
