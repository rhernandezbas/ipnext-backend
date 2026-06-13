# tickets-list-columns (#75 #76 #78 #79)

## Why
La lista de tickets (`/admin/tickets`) necesita cuatro ajustes de columnas, todos
sobre los mismos archivos (catálogo `ALL_TICKET_COLUMNS` + render `TicketsTableView`):

- **#75** — Área debe verse en posición 2 (tras ID) por default.
- **#76** — el nombre del cliente debe ser hipervínculo al detalle del cliente.
- **#78** — la columna "Tipo" es un campo muerto y ensucia la lista.
- **#79** — falta un Timer SLA (minutos desde createdAt) con color por umbrales
  configurables desde /admin/tickets/settings.

## What

### #78 — eliminar columna "Tipo" (campo muerto)
Investigación: el campo `type` NO existe en la entity `Ticket` del dominio BE, ni
en `TicketDto`, ni en `ListTickets`/`CreateTicket`, ni en el modelo Prisma
`Ticket`. El BE nunca lo populó → la columna renderizaba vacío para toda fila.
Se elimina la columna del catálogo y del render. El campo `type` del type FE queda
`@deprecated` y opcional (sólo por compat de mocks). El stale `type` en
localStorage se tolera (el `.filter()` del render descarta keys sin renderer).

### #75 — Área a posición 2 por default
Se reordena `ALL_TICKET_COLUMNS` para que `areaName` quede en índice 1 (tras `id`).
`DEFAULT_VISIBLE_COLUMNS = ALL_TICKET_COLUMNS.map(c => c.key)` deriva el orden
default. `useVisibleColumns` ya respeta el orden GUARDADO en localStorage
(`tickets-visible-columns`): un usuario que reordenó NO se ve pisado; sólo cambia
el default para quien no tocó nada (las keys nuevas se appendean al final).

### #76 — nombre del cliente como link
En `TicketsTableView`, la celda `customerName` pasa a ser un
`<Link to={/admin/customers/view/:customerId}>` (patrón #71/#56), con fallback a
texto plano si falta `customerId`. El `TicketDto` ya expone `customerId`.

### #79 — columna Timer SLA configurable (posición 3)
- **BE (este repo, aditivo):** config singleton `TicketSlaConfig` (patrón de
  `IClassClosureConfig`) con `warnMinutes` (default 60) y `dangerMinutes`
  (default 240). Rutas `GET/PUT /api/tickets/sla-config` (read / `tickets.manage`).
  Invariante `dangerMinutes > warnMinutes` validada en el use case contra la
  config MERGED → `TicketSlaThresholdOrderError` → 422. Migración aditiva +
  seed idempotente del singleton.
- **FE:** columna Timer en posición 3 (tras id, areaName) que muestra minutos
  desde `createdAt` (formato "{n} min" / "{h}h {m}m"), con color verde→amarillo→
  rojo por los umbrales del config. Sección "SLA / Timer" en
  /admin/tickets/settings (gate `tickets.manage`) con los 2 umbrales editables.

## Tickets cerrados (#79 — decisión)
Un ticket cerrado NO corre SLA: el timer se CONGELA mostrando el tiempo total
transcurrido entre `createdAt` y el cierre, pero en color NEUTRO (gris), sin
escalar a amarillo/rojo. Un ticket cerrado nunca "está en peligro". El estado
"cerrado" se detecta por los slugs canónicos (`closed`/`cerrado`), igual que la
pill de estado (#26). Si `createdAt` falta, la celda muestra "—".

## Wire contract (#79)
- BE: `TicketSlaConfigDto { warnMinutes: number; dangerMinutes: number }`.
  - `GET /api/tickets/sla-config` → 200 `TicketSlaConfigDto`.
  - `PUT /api/tickets/sla-config` body parcial `{ warnMinutes?, dangerMinutes? }`
    (enteros ≥ 1). 400 VALIDATION_ERROR por shape; 422 TICKET_SLA_THRESHOLD_ORDER
    si la config merged tiene `dangerMinutes <= warnMinutes`.
- FE: `useTicketSlaConfig()` lee el GET; la sección de settings hace el PUT.

## Orden final de columnas
`id, areaName(#75), timer(#79), subject, customerName(link #76), reporterName,
priority, status, assigneeName, createdAt` — sin `type` (#78).

## Permisos
No agrega superficie de lectura nueva (la lista ya está gateada con `tickets.read`).
El PUT de SLA config exige `tickets.manage`, igual que el resto de la config de
tickets (#49). El `<Link>` de #76 no requiere permiso extra (la ruta de detalle de
cliente ya está gateada con `clients.read`).
