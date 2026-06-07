# Design — ticket-assignee-filter (#25)

BE (port + repo + ruta) + FE (query type + call). Asignado + fechas.

## Backend

### Port `ListTicketsQuery` (`domain/ports/TicketRepository.ts`)
```ts
export interface ListTicketsQuery extends PaginatedQuery {
  search?: string;
  status?: TicketStatus;
  priority?: TicketPriority;
  customerId?: string;
  assigneeId?: string;   // #25
  from?: string;         // #25 — ISO date (YYYY-MM-DD), createdAt >=
  to?: string;           // #25 — ISO date, createdAt <= fin del día
}
```

### `PrismaTicketRepository.list` (where)
```ts
if (query.assigneeId) where['assigneeId'] = query.assigneeId;
if (query.from || query.to) {
  where['createdAt'] = {
    ...(query.from && { gte: new Date(query.from) }),
    ...(query.to && { lte: new Date(`${query.to}T23:59:59.999Z`) }), // incluir el día completo
  };
}
```

### `InMemoryTicketRepository.list` (tests)
- Filtrar el array por `assigneeId` exacto y por `createdAt` dentro de `[from, to]` (con el mismo criterio de fin-de-día), antes de paginar.

### Ruta `GET /tickets` (`tickets.routes.ts`)
- Extraer también `assignedTo`, `from`, `to` de `req.query` y pasarlos a `ListTickets` como `{ assigneeId: assignedTo, from, to }` (mapeo de naming FE `assignedTo` → BE `assigneeId`).

## Frontend

### `TicketsQuery` (`api/tickets.api.ts`)
- += `assignedTo?: string; from?: string; to?: string;`. (`getTickets` ya manda `normalisedParams` → los reenvía.)

### `TicketsListPage`
- `useTicketList({ …, assignedTo: filter.assignedTo || undefined, from: filter.from || undefined, to: filter.to || undefined })`.

## Tests (TDD)
- **BE** (`InMemoryTicketRepository` o `tickets.routes.new.test`): (a) filtrar por `assigneeId` → solo los de ese usuario, excluye `null`; (b) `from`/`to` → solo los del rango; (c) sin filtros → todos. RED primero (hoy ignora assigneeId/from/to).
- **FE**: si el `TicketsListPage`/hook tiene test, verificar que el query incluye assignedTo/from/to; si no, cubrir en el BE/ruta (que es donde estaba el agujero real).

## Riesgos
- Bajo. Predicados aditivos al `where`. El fin-de-día del `to` usa UTC (`T23:59:59.999Z`) — consistente con cómo se guarda `createdAt`; si hubiera desfase de TZ se nota en el borde del día (aceptable, se puede afinar luego).
