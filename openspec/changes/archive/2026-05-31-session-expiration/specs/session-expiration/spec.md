# Spec: session-expiration

## ADDED Requirements

### Requirement: Session liveness definition

A session SHALL be considered **alive** at a given instant if and only if all of
the following hold: it has not been revoked (`revokedAt IS NULL`), it is within
its absolute window (`expiresAt > now`), and it is within its inactivity window
(`lastSeenAt > now - 1 hour`). The inactivity TTL SHALL be 1 hour and the
absolute TTL SHALL be 8 hours (aligned to JWT `MAX_AGE_SECONDS = 28800`).

#### Scenario: Fresh session is alive
- **Given** a session created moments ago with `revokedAt = null`
- **When** liveness is evaluated
- **Then** the session is alive

#### Scenario: Revoked session is not alive
- **Given** a session with `revokedAt` set
- **When** liveness is evaluated
- **Then** the session is not alive

#### Scenario: Session idle beyond the inactivity window is not alive
- **Given** a session whose `lastSeenAt` is more than 1 hour in the past, still within its absolute window
- **When** liveness is evaluated
- **Then** the session is not alive

#### Scenario: Session within the inactivity window is alive
- **Given** a session whose `lastSeenAt` is 59 minutes in the past and whose `expiresAt` is in the future
- **When** liveness is evaluated
- **Then** the session is alive

#### Scenario: Session past its absolute cap is not alive
- **Given** a session whose `expiresAt` is in the past even though it was seen one minute ago
- **When** liveness is evaluated
- **Then** the session is not alive

#### Scenario: Legacy session with no expiry is not alive
- **Given** a session whose `expiresAt` is null (predating the column)
- **When** liveness is evaluated
- **Then** the session is not alive

### Requirement: Absolute expiry stamped at creation

When a session is created, the repository SHALL set `expiresAt = loginAt + 8h`
(the absolute TTL) so every new session carries its absolute cap.

#### Scenario: Create stamps expiresAt
- **Given** a session is created via the repository
- **When** the created session is inspected
- **Then** `expiresAt` equals `loginAt` plus 8 hours

### Requirement: Active list excludes expired and idle sessions

`listActive` SHALL return only alive sessions. Sessions that are revoked,
expired by the absolute cap, or idle past the inactivity window SHALL NOT appear.

#### Scenario: Idle session excluded from active list
- **Given** a session idle for more than 1 hour but within its absolute window
- **When** the active sessions are listed
- **Then** the session is not in the result

#### Scenario: Absolutely-expired session excluded from active list
- **Given** a session whose `expiresAt` is in the past, recently seen
- **When** the active sessions are listed
- **Then** the session is not in the result

#### Scenario: Alive session included in active list
- **Given** a freshly created, recently-seen session
- **When** the active sessions are listed
- **Then** the session is in the result

### Requirement: Stateful auth rejects non-alive sessions

The auth middleware SHALL reject a request whose backing session is not alive
(revoked, expired, or idle) with HTTP 401, the same treatment as a revoked
session.

#### Scenario: Request with an absolutely-expired session is rejected
- **Given** a valid JWT whose session `expiresAt` is in the past
- **When** a protected endpoint is requested
- **Then** the response status is 401

#### Scenario: Request with an idle session is rejected
- **Given** a valid JWT whose session has been idle for more than 1 hour
- **When** a protected endpoint is requested
- **Then** the response status is 401

### Requirement: Session history includes expired and idle sessions

The session-history listing (`findRevoked`) SHALL include every inactive
session: revoked OR expired by the absolute cap OR idle past the inactivity
window. Alive sessions SHALL NOT appear in history.

#### Scenario: History lists revoked, expired and idle sessions
- **Given** one revoked, one absolutely-expired, one idle and one alive session
- **When** the session history is listed
- **Then** the result contains the revoked, expired and idle sessions and excludes the alive one

### Requirement: SessionDto exposes expiresAt

The session DTO SHALL include `expiresAt` and SHALL continue to omit
`tokenHash`.

#### Scenario: DTO carries expiresAt, never tokenHash
- **Given** a session mapped to its DTO
- **When** the DTO is inspected
- **Then** it has an `expiresAt` field and has no `tokenHash` field
