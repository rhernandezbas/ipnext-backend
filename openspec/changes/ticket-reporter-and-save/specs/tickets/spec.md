# Delta for tickets

## ADDED Requirements

### REQ-TICKET-CREATE-1: Reporter defaults to the authenticated user on create

**Given** an authenticated `POST /api/tickets` request
**And** the body omits `reporterId` (absent or explicit `null`)
**When** the ticket is created
**Then** the server MUST respond with HTTP 201
**And** the created `Ticket`'s `reporterId` MUST equal `req.user.id` (the authenticated RbacUser)
**And** the response MUST include `reporterName` resolved from the RbacUser (JOIN-derived)

Rationale: `User.id == RbacUser.id` by construction in `JwtAuthAdapter`. Mirror of `POST /api/tickets/:id/tasks` which already stamps `reporterId: data.reporterId ?? req.user?.id ?? null`.

### REQ-TICKET-CREATE-2: Explicit reporterId in body wins over the default

**Given** an authenticated `POST /api/tickets` request
**And** the body provides a `reporterId` belonging to an existing RbacUser
**When** the ticket is created
**Then** the created `Ticket`'s `reporterId` MUST equal the value from the body (NOT `req.user.id`)

### REQ-TICKET-READ-1: Ticket responses expose reporterId and reporterName

**Given** any ticket read (`GET /api/tickets`, `GET /api/tickets/:id`) or write response
**When** the response is serialized
**Then** the `Ticket` DTO MUST include `reporterId: string | null` and `reporterName: string | null`
**And** `reporterName` MUST be the JOIN-derived RbacUser name (null when `reporterId` is null or the user is missing)

### REQ-TICKET-READ-2: Legacy tickets without a reporter render null

**Given** a ticket created before this change (no `reporterId` persisted)
**When** it is read
**Then** `reporterId` MUST be `null` and `reporterName` MUST be `null`
**And** no error is raised (the column is nullable; no backfill)

### REQ-TICKET-UPDATE-1: PATCH /:id accepts status as part of a unified save

**Given** an authenticated `PATCH /api/tickets/:id` request
**And** the body provides `status` (a catalog status name, any casing)
**And** the body may also provide `assigneeId` and/or `priority`
**When** the request is processed
**And** the status name exists in `TicketStatusCatalog` (case-insensitive match)
**Then** the server MUST respond with HTTP 200
**And** the ticket's status MUST be persisted as the CANONICAL catalog name (not the casing sent)
**And** `assigneeId` and `priority` (when provided) MUST be persisted in the SAME request

Rationale: enables the unified GUARDAR button in the detail sidebar — one PATCH persists assignee + status + priority together. No new route.

### REQ-TICKET-UPDATE-2: Unknown status in PATCH /:id is rejected without partial writes

**Given** an authenticated `PATCH /api/tickets/:id` request
**And** the body provides a `status` that does NOT exist in the catalog (case-insensitive)
**When** the request is processed
**Then** the server MUST respond with HTTP 422
**And** the body MUST contain `code: 'TICKET_STATUS_NOT_FOUND'`
**And** the ticket MUST remain unchanged (no partial write of assigneeId/priority)

Rationale: lección #46 — status is validated against the catalog (single source of truth), never a hardcoded whitelist. Validation happens BEFORE any persistence so an invalid status does not partially apply the other fields.

### REQ-TICKET-UPDATE-3: PATCH /:id without status keeps existing behavior

**Given** an authenticated `PATCH /api/tickets/:id` request
**And** the body omits `status`
**When** the request is processed
**Then** the server MUST behave exactly as before this change (update subject/description/priority/assigneeId)
**And** the ticket's status MUST remain unchanged

Rationale: additive, backward-compatible. Existing callers (assign-only PATCH) keep working.
