# suricata-tickets-ui Specification

## Purpose

A Prominense panel (`ipnext-frontend`) that reads the Suricata mirror: a filterable ticket list with KPIs, and a detail view with Conversation / AI Analysis / Client Data tabs. The panel is read-model only — reply and verdict submission are separate, explicit, audited actions defined in other capabilities.

## Requirements

### Requirement: UI-1 — filterable ticket list

The list MUST support filtering by status, priority, area and bot state (`unreviewed` / `resolved by bot` / `needed human`, derived from VERDICT-5's current verdict), and MUST show per-row badges for those attributes plus the assigned agent.

#### Scenario: filter by bot state

- GIVEN tickets with mixed current verdicts (some `resuelto:true`, some `resuelto:false`, some with no verdict yet)
- WHEN the user filters by "needed human"
- THEN only tickets whose current verdict is `resuelto:false` are shown

### Requirement: UI-2 — detail view with three tabs

The ticket detail MUST expose three tabs: Conversation, AI Analysis, and Client Data. Switching tabs MUST NOT trigger any live Suricata call — all data comes from the mirror.

#### Scenario: opening detail loads from the mirror only

- GIVEN a mirrored ticket
- WHEN its detail view is opened
- THEN the Conversation, AI Analysis and Client Data tabs render from stored data, with no request made to Suricata

### Requirement: UI-3 — conversation tab renders playable audio

The Conversation tab MUST render the message timeline in order and MUST render audio attachments as inline, playable audio elements (not bare download links).

#### Scenario: audio attachment in the thread

- GIVEN a message with an audio attachment already migrated to internal storage (MIRROR-7)
- WHEN the Conversation tab renders that message
- THEN the audio is playable inline in the thread

### Requirement: UI-4 — AI Analysis tab shows the current verdict

The AI Analysis tab MUST display the current (most recent) structured verdict: `resuelto`, `analisis`, and `motivo`/`respuestaSugerida` when present. A ticket with no verdict yet MUST show an explicit "no verdict" state, not an error.

#### Scenario: ticket with a verdict

- GIVEN a ticket whose current verdict is `resuelto:false` with `motivo` and `respuestaSugerida`
- WHEN the AI Analysis tab renders
- THEN all four fields are visible

#### Scenario: ticket without any verdict

- GIVEN a ticket that never received a verdict
- WHEN the AI Analysis tab renders
- THEN it shows an explicit empty state, not an error or a blank crash

### Requirement: UI-5 — Client Data tab follows the 360 checklist, read-only

The Client Data tab MUST present the five sections used by the `atencion-suricata-ipnext` "Análisis 360" checklist: (1) history of prior conversations, (2) current claim summary, (3) whether this matches a prior claim's same root cause, (4) equipment/signal status when applicable, (5) administrative/debt status via Gestión Real. This tab MUST only read from existing integrations — it MUST NOT write to Gestión Real or any other source system.

#### Scenario: client data renders from existing sources

- GIVEN a ticket linked to a known client with prior tickets and an existing Gestión Real debt record
- WHEN the Client Data tab renders
- THEN all five sections show data sourced from existing read paths, with no write performed against Gestión Real or any other integration

### Requirement: UI-6 — KPI strip from stored data

The KPI strip MUST show: % resolved by bot alone, % needed human, % without a verdict, and count synced today — all computed from mirrored/verdict data, never a live Suricata query.

#### Scenario: KPIs recompute after a new verdict

- GIVEN a ticket moves from "no verdict" to a current verdict of `resuelto:true`
- WHEN the KPI strip is recomputed
- THEN "% resolved by bot" increases and "% without a verdict" decreases accordingly

### Requirement: UI-7 — Prominense-only assignment field

The assignment field MUST be editable from the panel and MUST persist only in Prominense; it MUST NOT be written back to Suricata.

#### Scenario: assigning a ticket

- GIVEN an unassigned mirrored ticket
- WHEN a user assigns it to an agent
- THEN the assignment is stored locally and no write is issued to Suricata

### Requirement: UI-8 — RBAC-gated visibility of actions

The list and detail views MUST be visible only to users holding the panel's read permission. The reply entry point (REPLY-1) MUST only be enabled for users holding the reply permission; other users MUST NOT see it as actionable.

#### Scenario: read-only user cannot see reply as actionable

- GIVEN a user with `suricata.read` but not `suricata.reply`
- WHEN they open a ticket detail
- THEN the reply action is not available to them
