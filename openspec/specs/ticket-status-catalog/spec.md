# Spec: ticket-status-catalog

## Overview

An editable catalog of ticket statuses with name (unique), color (hex), and weight (sort order). Mirrors TaskPriority. Ticket.status continues to store the status name as a string; the catalog drives the UI dropdown.

## Scenarios

### SC-1: List ticket statuses (ordered by weight)
- Given at least one TicketStatus exists
- When `GET /api/tickets/statuses` is called
- Then returns array of TicketStatus DTOs sorted by weight asc

### SC-2: Get single ticket status by id
- Given a TicketStatus with id=X exists
- When `GET /api/tickets/statuses/:id` is called
- Then returns the TicketStatus DTO
- If not found, returns 404 with code TICKET_STATUS_NOT_FOUND

### SC-3: Create ticket status
- Given `POST /api/tickets/statuses` with `{ name, color, weight }`
- When name is unique (case-insensitive)
- Then returns 201 with the new TicketStatus DTO
- When name already exists → 409 TICKET_STATUS_NAME_CONFLICT

### SC-4: Update ticket status
- Given a TicketStatus with id=X
- When `PUT /api/tickets/statuses/:id` with partial `{ name?, color?, weight? }`
- Then returns updated DTO
- If not found → 404
- If name collides with another → 409

### SC-5: Delete ticket status
- Given a TicketStatus with id=X
- When `DELETE /api/tickets/statuses/:id` is called
- And no tickets use that status name
- Then returns 204
- If in use → 409 TICKET_STATUS_IN_USE
- If not found → 404

### SC-6: Canonical values seeded
- After `npm run prisma:seed`, statuses open/pending/closed exist with sensible colors and weights

## Constraints

- `name` must be unique, case-insensitive check in use-case layer
- `color` is a non-empty string (hex recommended, validated by client)
- `weight` is an integer (sort order, lower = first)
- Delete guard: if any Ticket.status === catalogEntry.name, reject with TICKET_STATUS_IN_USE
- Authentication required on all endpoints (same middleware as TaskPriority)
