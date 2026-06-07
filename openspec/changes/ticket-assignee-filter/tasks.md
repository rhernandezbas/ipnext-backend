# Tasks — ticket-assignee-filter (#25)

Strict TDD (red→green). Asignado + fechas. BE primero (donde está el agujero), FE después.

## Backend (ipnext-backend)

- [ ] **1. RED+GREEN — repo filtra por asignado + fechas** (`tickets.routes.new.test` o test del repo in-memory)
  - RED: (a) filtrar por `assigneeId=U` → solo los de U, excluye los `null`/otros; (b) `from`/`to` → solo los del rango por `createdAt`; (c) sin filtros → todos.
  - GREEN:
    - `ListTicketsQuery` += `assigneeId?` / `from?` / `to?`.
    - `PrismaTicketRepository.list`: `if (query.assigneeId) where.assigneeId = …`; `if (query.from||query.to) where.createdAt = { gte?, lte: ${to}T23:59:59.999Z }`.
    - `InMemoryTicketRepository.list`: filtrar por `assigneeId` + rango `createdAt` antes de paginar.

- [ ] **2. Ruta `GET /tickets`** — extraer `assignedTo`, `from`, `to` de `req.query` y pasarlos a `ListTickets` como `{ assigneeId: assignedTo, from, to }`.

- [ ] **3. Verify BE** — `tsc` (0) + `npx jest --runInBand` (verde). Commit + deploy (OK) + `gh`.

## Frontend (ipnext-frontend)

- [ ] **4. `TicketsQuery` + el call**
  - `api/tickets.api.ts`: `TicketsQuery` += `assignedTo?` / `from?` / `to?`.
  - `TicketsListPage`: `useTicketList({ …, assignedTo: filter.assignedTo || undefined, from: filter.from || undefined, to: filter.to || undefined })`.

- [ ] **5. Verify FE** — `tsc` (0) + `npx vitest run` (verde). Commit + deploy (OK) + `gh`. Validación visual: filtrar por Asignado y por fechas en tickets.

## Cierre

- [ ] **6. Archive + docs** — `sdd-archive` (mover change a `archive/`). Commit del `BACKLOG.md`: #25 → hecho (+ #19/#20/#21/#23/#24/#26/#27 quedan; viajan los nuevos).
