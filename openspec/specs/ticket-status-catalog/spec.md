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

### SC-7: Status update validado contra el catálogo
- `PATCH /api/tickets/:id/status` MUST validar `body.status` contra `TicketStatusCatalog` (lookup por nombre, case-insensitive) en lugar de una whitelist hardcodeada
- El sistema MUST persistir el nombre canónico del catálogo (no el input crudo)
- Status ausente o vacío MUST devolver 400 `VALIDATION_ERROR`
- Status inexistente en el catálogo MUST devolver 422 `TICKET_STATUS_NOT_FOUND` sin modificar el ticket

#### SC-7.1: Status custom del catálogo aceptado (regresión del 400 actual)
- GIVEN el catálogo contiene "Resuelto" y un ticket abierto
- WHEN `PATCH /:id/status` con `{ "status": "Resuelto" }`
- THEN 200 y el ticket queda con status "Resuelto"

#### SC-7.2: Cierre desde el detalle con catálogo en español (caso 'cerrado')
- GIVEN el catálogo contiene "Cerrado" (y NO "closed")
- WHEN `PATCH /:id/status` con `{ "status": "cerrado" }` (fallback CLOSED_SLUGS del FE)
- THEN 200 y el ticket persiste el nombre canónico "Cerrado"

#### SC-7.3: Dirección inversa — catálogo legacy en inglés sigue funcionando
- GIVEN el catálogo seedeado solo con open/pending/closed
- WHEN `PATCH /:id/status` con `{ "status": "closed" }`
- THEN 200 (sin regresión sobre el contrato actual)

#### SC-7.4: Status inexistente rechazado
- GIVEN el catálogo no contiene "archivado"
- WHEN `PATCH /:id/status` con `{ "status": "archivado" }`
- THEN 422 con code `TICKET_STATUS_NOT_FOUND` y el ticket no cambia

#### SC-7.5: Status faltante
- WHEN `PATCH /:id/status` sin `status` en el body
- THEN 400 con code `VALIDATION_ERROR`

### SC-8: Filtro de status pass-through en la lista
- `GET /api/tickets?status=X` MUST pasar el filtro `status` al repositorio siempre que venga presente
- El sistema MUST NOT descartar el filtro silenciosamente
- Un status sin tickets que matcheen devuelve lista vacía, nunca la lista sin filtrar

#### SC-8.1: Filtro por status custom aplica (bug latente actual)
- GIVEN tickets con status "Resuelto" y otros con "open"
- WHEN `GET /api/tickets?status=Resuelto`
- THEN 200 con SOLO los tickets "Resuelto"

#### SC-8.2: Status inexistente devuelve lista vacía
- GIVEN ningún ticket con status "nope"
- WHEN `GET /api/tickets?status=nope`
- THEN 200 con `data: []` (filtro aplicado, no ignorado)

#### SC-8.3: Sin filtro de status (regresión)
- WHEN `GET /api/tickets` sin `status`
- THEN 200 con la lista sin filtrar por status

## Constraints

- `name` must be unique, case-insensitive check in use-case layer
- `color` is a non-empty string (hex recommended, validated by client)
- `weight` is an integer (sort order, lower = first)
- Delete guard: if any Ticket.status === catalogEntry.name, reject with TICKET_STATUS_IN_USE
- Authentication required on all endpoints (same middleware as TaskPriority)
