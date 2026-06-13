# Spec Delta: recaptacion-leads (#80)

## ADDED Requirements

### Requirement: Lead model decoupled from Client
The system SHALL store recapture leads in a `RecaptureLead` entity independent from `Client`, with an optional `clientId` FK and a contact snapshot (contactName, phone, email), so future CSV-sourced leads need no remodeling.

#### Scenario: Churned client becomes a lead
- WHEN the churned ingest runs over a `Client` with `status = 'baja'`
- THEN a `RecaptureLead` is created with `source = 'churned_client'`, `clientId` set, `status = 'nuevo'`, and the contact snapshot copied from the client

#### Scenario: Ingest is idempotent
- WHEN the churned ingest runs twice
- THEN no duplicate `RecaptureLead` is created for the same `clientId` (partial unique index enforces one lead per churned client)

### Requirement: Race-safe claim
The system SHALL allow a user to claim a lead atomically. A claim SHALL succeed only if the lead is currently unassigned.

#### Scenario: Two users claim the same lead
- GIVEN a lead with `assigneeId = null`
- WHEN user A and user B claim it concurrently
- THEN exactly one succeeds (assigneeId set, claimedAt set, status 'en_gestion') and the other receives HTTP 409

#### Scenario: Claim next available
- WHEN a user requests claim-next
- THEN the system atomically assigns the oldest lead with status 'nuevo' and assigneeId null, or returns no-content/404 if none are free

#### Scenario: Release a lead
- GIVEN a lead claimed by user A
- WHEN user A (or a manager) releases it
- THEN assigneeId becomes null and status returns to 'nuevo'

### Requirement: Contact log (bitacora)
The system SHALL record each recapture contact as a `RecaptureContact` linked to the lead, capturing channel, outcome, proposal, note, and next-step date.

#### Scenario: Register a contact
- WHEN a user with `recapture.manage` posts a contact for a lead
- THEN a `RecaptureContact` is appended with actorId, channel, outcome, optional proposal/note/nextStepAt, and the lead status MAY be advanced

#### Scenario: Lead detail returns timeline
- WHEN a user with `recapture.read` fetches a lead
- THEN the response includes the lead plus its contacts ordered newest-first

### Requirement: RBAC gating
The system SHALL expose `recapture.read` and `recapture.manage` permissions via `/me` and enforce them on the recapture endpoints.

#### Scenario: Read without permission
- WHEN a user lacking `recapture.read` calls GET /api/recapture/leads
- THEN the response is 403

#### Scenario: Manage gates write operations
- WHEN a user lacking `recapture.manage` calls claim/release/contacts
- THEN the response is 403

### Requirement: DTO mapping
The recapture endpoints SHALL never return raw Prisma entities; all outputs are mapped to DTOs.

#### Scenario: List returns DTOs
- WHEN GET /api/recapture/leads is called
- THEN each item is a RecaptureLeadDTO (no Prisma internals leaked)

## Out of scope (this change)
- CSV import (model is prepared; not implemented)
- Telephony integration (external app; only logging)
