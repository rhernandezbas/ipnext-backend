# Proposal — ticket-assignee-filter (#25)

Mode: interactive · Store: hybrid (openspec + engram `sdd/ticket-assignee-filter/*`).

## Why

En tickets, filtrar por **Asignado = X** no filtra: sigue trayendo tickets sin asignar. El filtro existe en la UI (`TicketFilterBar`) y en la URL (`filter.assignedTo`), pero **no llega a la query** y **el backend no lo soporta**. Verificado: roto en todas las capas.

## Diagnóstico (verificado)

| Capa | Estado |
|------|--------|
| FE `TicketsListPage` | NO pasa `assignedTo` al `useTicketList` (pasa solo search/status/priority/customerId). |
| Ruta `GET /tickets` | extrae `page/limit/search/status/priority/customerId` de `req.query` — **no lee** el asignado. |
| Port `ListTicketsQuery` | sin `assigneeId`. |
| `PrismaTicketRepository.list` | el `where` no filtra por `assigneeId`. |
| **Tareas** | ✅ OK — `listTasks` ya filtra por `assigneeId`. No se toca. |
| Reporter | no hay filtro de reporter en tickets ni tareas (no aplica). |

## Decisiones

- **AD-1 — Agregar el filtro de asignado al ticket-list end-to-end**: port + repo + ruta + FE. Filtra por `assigneeId` exacto (excluye los `null`).
- **AD-2 — Naming**: el FE ya manda `assignedTo` (en `TicketsQuery`); la ruta lo lee y lo pasa como `assigneeId` al use-case/repo (mapeo en la ruta, sin refactor del FE).

## What changes

### Backend
- `ListTicketsQuery` += `assigneeId?: string`.
- `PrismaTicketRepository.list`: `if (query.assigneeId) where['assigneeId'] = query.assigneeId`.
- `InMemoryTicketRepository.list`: filtrar por `assigneeId` (para tests).
- Ruta `GET /tickets`: leer `req.query.assignedTo` (o `assigneeId`) y pasarlo como `assigneeId` a `ListTickets`.

### Frontend
- `TicketsListPage`: pasar `assignedTo: filter.assignedTo || undefined` al `useTicketList`.

## Impact / Out of scope
- **Riesgo**: bajo. Agrega un predicado al `where`; no cambia los demás filtros.
- **DECIDIDO (usuario: "todo aquí")**: se incluye también **`from`/`to`** (filtros de fecha por `createdAt`). Hoy ni el FE los manda ni el BE los soporta → se agregan junto al asignado. Resultado: **todos los filtros del `TicketFilterBar` quedan funcionales** (asignado + fechas; estado/prioridad/búsqueda/cliente ya andan).
- El **#27** (prioridad en tareas) queda agendado por separado.
