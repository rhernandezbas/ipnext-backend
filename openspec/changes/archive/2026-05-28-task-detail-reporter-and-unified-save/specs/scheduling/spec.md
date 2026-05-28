# Delta for scheduling

## ADDED Requirements

### REQ-CREATE-9: Reporter defaults to the authenticated user when omitted

**Given** an authenticated `POST /api/scheduling` request
**And** the body omits `reporterId` (absent or explicit `null`)
**When** the request is processed
**Then** the server MUST respond with HTTP 201
**And** the created `ScheduledTask`'s `reporterId` MUST equal `req.user.id` (the authenticated admin)

Rationale: `User.id == admin.id` by construction in `JwtAuthAdapter` (the JWT is issued from the admin record at login). The default value passes the existing FK validation against `adminLookup`.

### REQ-CREATE-10: Explicit reporterId in body wins over the default

**Given** an authenticated `POST /api/scheduling` request
**And** the body provides a `reporterId` belonging to an existing admin
**When** the request is processed
**Then** the server MUST respond with HTTP 201
**And** the created `ScheduledTask`'s `reporterId` MUST equal the value from the body (NOT `req.user.id`)

### REQ-CREATE-11: Defaulted reporter is still validated against the admin lookup

**Given** an authenticated `POST /api/scheduling` request
**And** the body omits `reporterId`
**And** the authenticated user's `id` does NOT correspond to a known admin (anomalous state — never happens for real sessions)
**When** the request is processed
**Then** the server MUST respond with HTTP 404
**And** the body MUST contain a `code` mapped from `ReferenceNotFoundError('reporter', ...)` (same code used for an invalid explicit `reporterId`)

Rationale: documents the contract that the defaulted value goes through the same FK validation path as an explicit one. No special-casing.
