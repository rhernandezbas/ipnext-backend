# Change: ticket-area-color (#69)

## Why
La lista de tickets muestra el ÁREA solo como texto. El pedido #69 es renderizar el área como
**pill con color llamativo**, con el color editable desde el catálogo de áreas
(`/admin/tickets/settings`). El patrón a espejar ya existe en TicketStatus: el catálogo de estados
tiene un campo `color` y la columna "Estado" renderiza un pill con ese color.

## What
- `TicketAreaCatalog` gana un campo `color` (TEXT hex). ABM acepta/devuelve `color`.
- DTO de tickets (list + detail) expone `areaColor` (JOIN-derived, mirror de `areaName`).
- FE: columna "Área" en la lista de tickets como pill con el color del catálogo; '—' sin área.
  Visible por default en el column selector. ABM de áreas gana input de color.
- Catalog-driven: cero hardcodeo de nombres de área (lección #27). El usuario cargará más áreas.

## Scope
- BE: `prisma/schema.prisma`, migración aditiva, entity/port/adapters/use-cases/dto/route del
  catálogo de áreas, INCLUDE + mapper de `PrismaTicketRepository`, `TicketDto`/entity `Ticket`.
- FE: tipos, api client, hook, `TicketAreasBody` (color input + swatch), `ALL_TICKET_COLUMNS`,
  `TicketsTableView` (AreaPill + columna), tests.

## Out of scope
- No se agrega `statusColor` inline al ticket DTO (hoy no existe; el área es lo pedido).
- No se cambia el contraste del pill de estado (sigue texto blanco; el de área lo espeja).

## Wire contract (campo por campo)
Catálogo de áreas (`/api/tickets/areas`):
- request create: `{ name: string, color: string (hex) }`
- request update: `{ name?: string, color?: string (hex) }`
- response: `{ id, name, color }`

Ticket DTO (list + detail) — campo nuevo:
- `areaColor: string | null` — JOIN-derived de `TicketAreaCatalog.color`; null si el ticket no tiene área.
