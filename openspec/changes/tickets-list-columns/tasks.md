# tickets-list-columns — tasks

## #78 — eliminar columna "Tipo" (FE)
- [x] Test: `type` no está en `ALL_TICKET_COLUMNS`; el header "Tipo" no se renderiza por el path real; stale `type` en localStorage tolerado.
- [x] Quitar `type` de `ALL_TICKET_COLUMNS` y de `ALL_COLUMNS` (render).
- [x] Marcar `Ticket.type` como `@deprecated` y opcional (compat de mocks).

## #75 — Área a posición 2 por default (FE)
- [x] Test: `areaName` en índice 1 del catálogo; usuario sin nada guardado obtiene el default; usuario con orden guardado NO se pisa.
- [x] Reordenar `ALL_TICKET_COLUMNS` (areaName tras id).

## #79 — config de umbrales SLA (BE)
- [x] Port `TicketSlaConfigRepository` (get/update, defaults 60/240).
- [x] DTO `TicketSlaConfigDto` + `UpdateTicketSlaConfigSchema` (Zod, partial, enteros ≥ 1).
- [x] Error de dominio `TicketSlaThresholdOrderError` → 422 en el statusMap.
- [x] Use cases `GetTicketSlaConfig` / `UpdateTicketSlaConfig` (invariante contra config merged).
- [x] Adapters `InMemoryTicketSlaConfigRepository` / `PrismaTicketSlaConfigRepository`.
- [x] Router `GET/PUT /api/tickets/sla-config` (read / manage), montado antes de `/api/tickets`.
- [x] Modelo Prisma `TicketSlaConfig` (singleton) + migración aditiva `20260713000000_ticket_sla_config` + seed idempotente.
- [x] Wiring en `app.ts`.
- [x] Tests: use case (in-memory) + seam de routes (GET/PUT route→use case→repo).

## #79 — columna Timer SLA (FE)
- [ ] Helper puro `slaTimerColor(elapsedMin, warn, danger, isClosed)` + formato de tiempo.
- [ ] Hook `useTicketSlaConfig()` + api client.
- [ ] Columna `timer` en posición 3 de `ALL_TICKET_COLUMNS` + render en `TicketsTableView`.
- [ ] Sección "SLA / Timer" en /admin/tickets/settings (gate `tickets.manage`).
- [ ] Tests: helper de color por umbral, columna por path real, sección settings.

## #76 — nombre del cliente como link (FE)
- [ ] Test del href `/admin/customers/view/:customerId` + fallback sin customerId.
- [ ] Celda `customerName` → `<Link>` en `TicketsTableView`.
