# Tasks: ticket-area-color (#69)

## BE
- [x] Prisma: `TicketAreaCatalog.color String @default("#6366f1")`
- [x] Migration `20260709000000_ticket_area_color` (ADD COLUMN IF NOT EXISTS, NOT NULL DEFAULT, idempotent UPDATE by name)
- [x] Entity `TicketAreaCatalog.color`
- [x] Port `create/update` accept color
- [x] InMemory + Prisma adapters map/persist color
- [x] DTO: `CreateTicketAreaSchema`/`UpdateTicketAreaSchema` add hex-validated color
- [x] Use cases `CreateTicketArea`/`UpdateTicketArea` accept color
- [x] Ticket entity + `TicketDto`: add `areaColor`
- [x] `PrismaTicketRepository` INCLUDE `area.color` + map `areaColor`
- [x] InMemoryTicketRepository resolve `areaColor` on create/update
- [x] SplynxTicketAdapter: `areaColor: null`
- [x] Tests (RED→GREEN): use-case color, route color + hex 400, toTicket areaColor

## FE
- [x] Types: `TicketArea.color`, `Ticket.areaColor`
- [x] API client + hook: color in create/update
- [x] `utils/contrastColor.ts` (readableTextColor) + test
- [x] `ALL_TICKET_COLUMNS`: add `{ key: 'areaName', label: 'Área' }` (default visible)
- [x] `TicketsTableView`: `AreaPill` + column (key `areaName`)
- [x] `TicketAreasBody`: color input + swatch column
- [x] Tests: area column via visibleColumnKeys, ABM color, hook color, contrast

## Gates
- [x] BE tsc clean, targeted jest green
- [x] FE typecheck clean, targeted vitest green
