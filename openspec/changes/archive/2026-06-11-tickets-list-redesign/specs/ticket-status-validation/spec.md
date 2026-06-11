# Delta for Ticket Status Validation

> BE — `tickets.routes.ts`. La whitelist `VALID_STATUSES` (L59) era solo código, sin spec previa: este delta crea la capability que la reemplaza. Complementa `ticket-status-catalog` (el catálogo pasa a ser la única fuente de verdad de statuses válidos).

## ADDED Requirements

### Requirement: Status update validado contra el catálogo

`PATCH /api/tickets/:id/status` MUST validar `body.status` contra `TicketStatusCatalog` (lookup por nombre, case-insensitive) en lugar de una whitelist hardcodeada. El sistema MUST persistir el nombre canónico del catálogo (no el input crudo). Status ausente o vacío MUST devolver 400 `VALIDATION_ERROR`; status inexistente en el catálogo MUST devolver 422 `TICKET_STATUS_NOT_FOUND` sin modificar el ticket.

#### Scenario: Status custom del catálogo aceptado (regresión del 400 actual)

- GIVEN el catálogo contiene "Resuelto" y un ticket abierto
- WHEN `PATCH /:id/status` con `{ "status": "Resuelto" }`
- THEN 200 y el ticket queda con status "Resuelto"

#### Scenario: Cierre desde el detalle con catálogo en español (caso 'cerrado')

- GIVEN el catálogo contiene "Cerrado" (y NO "closed")
- WHEN `PATCH /:id/status` con `{ "status": "cerrado" }` (fallback CLOSED_SLUGS del FE)
- THEN 200 y el ticket persiste el nombre canónico "Cerrado"
- AND (hoy: 400 — el cierre del detalle está roto con catálogo en español)

#### Scenario: Dirección inversa — catálogo legacy en inglés sigue funcionando

- GIVEN el catálogo seedeado solo con open/pending/closed
- WHEN `PATCH /:id/status` con `{ "status": "closed" }`
- THEN 200 (sin regresión sobre el contrato actual)

#### Scenario: Status inexistente rechazado

- GIVEN el catálogo no contiene "archivado"
- WHEN `PATCH /:id/status` con `{ "status": "archivado" }`
- THEN 422 con code `TICKET_STATUS_NOT_FOUND` y el ticket no cambia

#### Scenario: Status faltante

- WHEN `PATCH /:id/status` sin `status` en el body
- THEN 400 con code `VALIDATION_ERROR`

### Requirement: Filtro de status pass-through en la lista

`GET /api/tickets?status=X` MUST pasar el filtro `status` al repositorio siempre que venga presente. El sistema MUST NOT descartar el filtro silenciosamente: un status sin tickets que matcheen devuelve lista vacía, nunca la lista sin filtrar.

#### Scenario: Filtro por status custom aplica (bug latente actual)

- GIVEN tickets con status "Resuelto" y otros con "open"
- WHEN `GET /api/tickets?status=Resuelto`
- THEN 200 con SOLO los tickets "Resuelto"
- AND (hoy: devuelve la lista completa sin filtrar — el filtro se dropea en silencio)

#### Scenario: Status inexistente devuelve lista vacía

- GIVEN ningún ticket con status "nope"
- WHEN `GET /api/tickets?status=nope`
- THEN 200 con `data: []` (filtro aplicado, no ignorado)

#### Scenario: Sin filtro de status (regresión)

- WHEN `GET /api/tickets` sin `status`
- THEN 200 con la lista sin filtrar por status

## REMOVED Requirements

### Requirement: Whitelist estática de statuses

(Reason: `VALID_STATUSES = ['open','pending','closed']` — comportamiento solo-código, nunca spec'd — muere en sus DOS usos: el 400 de `PATCH /:id/status` y el drop silencioso del filtro en `GET /`. El catálogo es la única fuente de validación.)
