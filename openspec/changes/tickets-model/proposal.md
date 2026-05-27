# Proposal — tickets-model

## Intent

Hoy los TICKETS de Prominense NO son un dato propio: viven en Splynx (licencia vencida, `SplynxTicketAdapter` → `/api/2.0/admin/support/ticket`) y en una maraña de stores in-memory dentro de `tickets.routes.ts` (`ticketRepliesStore`, `ticketStatusStore`, `ticketEditsStore`, `deletedTicketsStore`, `ticketAssignmentStore`) más los contadores de `shared-stores.ts`. No existe `model Ticket` en `prisma/schema.prisma` (confirmado por grep).

El usuario quiere que los tickets sean una **fuente de datos REAL en la BD, con relación al CLIENTE**, exactamente como ya lo son las TAREAS: `ScheduledTask` tiene `customerId` FK → `Client` y el frontend cuenta/lista tareas por cliente con `GET /api/scheduling?customerId=X`. El objetivo concreto es que el botón **"Tickets (N)"** en la info del cliente funcione igual que **"Tareas (N)"** (contar por cliente, navegar al listado filtrado) y que los tickets "se vayan cargando a futuro" sobre datos persistidos.

Este es un cambio **backend-led** que reemplaza el backing de los casos de uso de tickets ya existentes (Splynx/in-memory → Prisma) e introduce el modelo, el puerto y los adapters siguiendo la arquitectura hexagonal estricta del repo, espejando el patrón de `ScheduledTask`.

## Problem

1. **No hay persistencia**: sin `model Ticket`, cualquier ticket creado depende de Splynx (caído por licencia) o se pierde al reiniciar el proceso (in-memory).
2. **No hay relación con el cliente**: el `Ticket` actual (`src/domain/entities/ticket.ts`) tiene `clientId: string` como texto libre, sin FK, sin JOIN al nombre real del `Client`. No se puede contar "tickets de este cliente" de forma confiable.
3. **Estado disperso e inconsistente**: el status, las ediciones, los borrados y las asignaciones viven en cinco `Map`/`Set` distintos dentro de la route. Los valores de status están mezclados en dos idiomas/convenciones: la entidad usa `'abierto' | 'en_progreso' | 'cerrado'`, pero `PATCH /:id/status` valida `['open','pending','resolved','closed']`. Hay drift real.
4. **El puerto no soporta el caso de uso pedido**: `TicketRepository.list(query)` filtra por `search/status/priority` pero **no por `customerId`**. Sin eso no se puede replicar el contador por cliente de las tareas.
5. **CRUD incompleto y simulado**: `getTask`, `updateStatus`, `delete` y `assign` se resuelven con overrides in-memory sobre el resultado de `list()`, no contra una fuente real.

## Scope IN

Backend:
- **`prisma/schema.prisma`** — nuevo `model Ticket` con FK `customerId` → `Client` (espejo de `ScheduledTask.customerId`), `assigneeId` → `Admin` opcional, índices por `customerId`/`status`/`assigneeId`.
- **Nueva migration** Prisma (creada con `npm run prisma:migrate` por el usuario — este plan NO la genera).
- **`src/domain/entities/ticket.ts`** — alinear la entidad con el modelo: agregar `customerName` (JOIN-derived), `customerId` como FK, `updatedAt`, unificar el vocabulario de `status`.
- **`src/domain/ports/TicketRepository.ts`** — agregar `customerId?` a `ListTicketsQuery`; agregar `getById`, `updateStatus`/`update`, `close`/`delete` para soportar el CRUD mínimo contra Prisma.
- **`src/application/use-cases/`** — extender `ListTickets` (pasar `customerId`), y nuevos use cases mínimos: `GetTicket`, `UpdateTicketStatus`, `CloseTicket` (o `UpdateTicket`). Verbo + sustantivo, un caso por archivo.
- **`src/application/dto/tickets.dto.ts`** — agregar `customerId` al filtro y a la salida; DTO de output que NO devuelva la entidad Prisma cruda.
- **Nuevo adapter** `src/infrastructure/adapters/prisma/PrismaTicketRepository.ts` (implementa `TicketRepository` contra Prisma, con `INCLUDE` del `customer` para derivar `customerName`, espejo de `PrismaSchedulingRepository`).
- **Nuevo adapter** `src/infrastructure/adapters/in-memory/InMemoryTicketRepository.ts` (para tests de use case y routes — hoy NO existe).
- **`src/infrastructure/http/routes/tickets.routes.ts`** — reescribir para apoyarse en el puerto/use cases reales en lugar de los stores in-memory dispersos; agregar passthrough de `?customerId` en `GET /`.
- **`src/infrastructure/http/app.ts`** — cambiar el wiring: inyectar `PrismaTicketRepository` en vez de `SplynxTicketAdapter`.
- **Tests** bajo `src/__tests__/` (use cases con InMemory; routes con supertest).

Frontend (coordinación, NO implementación aquí — ver design):
- Contador **"Tickets (N)"** en la info del cliente, vía `GET /api/tickets?customerId=X`.
- Listado de tickets filtrable por cliente, navegable desde ese botón.

## Scope OUT

- Implementación del frontend (repo hermano `ipnext-frontend`). Este proposal solo **especifica el contrato de coordinación**.
- **Replies/comentarios de ticket** como modelo persistido. `ticketRepliesStore` puede quedar in-memory en esta iteración o modelarse aparte; se documenta como decisión en `design.md` (recomendación: out-of-scope ahora, modelar `TicketReply` en un cambio siguiente).
- **Integración de `casos` de Gestión Real (GR)**. Out-of-scope ahora, pero el modelo deja previsto un `grCasoId String? @unique` (espejo de `Client.grClienteId` / `Service.grContratoId`) para enlazar a futuro sin re-migrar. Ver design.
- Eliminar definitivamente `SplynxTicketAdapter` (se conserva el archivo; solo se deja de cablear). Limpieza posterior.
- Reportes/stats avanzados más allá del `getStats` actual.

## Approach (alto nivel)

1. **Modelar** `Ticket` en Prisma con FK al `Client` (patrón `ScheduledTask`), generar la migration.
2. **Definir el puerto** completo (`list` con `customerId`, `getById`, `create`, `updateStatus`/`update`, `close`/`delete`, `getStats`) en `domain/ports`.
3. **Implementar adapters** Prisma (real) e InMemory (tests), con mapper `toTicket(row)` que deriva `customerName` del JOIN.
4. **Reemplazar el backing**: los use cases ya existentes (`ListTickets`, `CreateTicket`, `GetTicketStats`) pasan a hablar con el puerto Prisma. Se agregan los use cases del CRUD mínimo.
5. **Reescribir la route** para apoyarse en el puerto en vez de stores in-memory, agregando el passthrough `?customerId`.
6. **Re-cablear** `app.ts`: `PrismaTicketRepository` reemplaza a `SplynxTicketAdapter`.
7. **Frontend (lockstep)**: el contador "Tickets (N)" llama `GET /api/tickets?customerId=X` y usa `total`, igual que "Tareas (N)".

## Decisión clave: reemplazar vs convivir

**Se REEMPLAZA el backing, se CONSERVAN los contratos de los use cases.** Los archivos `ListTickets.ts`, `CreateTicket.ts`, `GetTicketStats.ts` y la route siguen existiendo y exponen la misma API HTTP (`GET /api/tickets`, `/stats`, `POST /`, etc.). Lo que cambia es **a quién le hablan**: hoy a `SplynxTicketAdapter`, después a `PrismaTicketRepository`. `SplynxTicketAdapter` NO se borra (se descablea) para permitir rollback rápido y porque sigue siendo una implementación válida del puerto. Esto evita un big-bang y mantiene la superficie HTTP estable para el frontend. Tradeoffs completos en `design.md` (AD-2).

## Risks

1. **Drift de vocabulario de `status`** — la entidad usa `'abierto'|'en_progreso'|'cerrado'` y la route valida `'open'|'pending'|'resolved'|'closed'`. El modelo Prisma debe fijar UN set canónico (recomendado: enum `TicketStatus { open, pending, closed }`, ver design AD-3) y la route debe mapear consistentemente. Riesgo de romper el front si cambia el shape del campo.
2. **`onDelete` del `customerId`** — siguiendo a `ScheduledTask`, se usa `onDelete: SetNull`: borrar un `Client` deja el ticket huérfano con `customerId=null`. Alternativa `Cascade` (borra los tickets). Decisión en design AD-4 — recomendado `SetNull` por consistencia con tareas.
3. **Stores in-memory de la route** — `ticketRepliesStore` y compañía desaparecen del flujo real. Hay que decidir qué queda (replies) y qué migra (status/edits/delete/assign → columnas reales). Riesgo de perder funcionalidad de la UI si no se mapea cada store a una columna/endpoint.
4. **Sin datos seed** — al reemplazar Splynx, la lista arranca vacía (es lo deseado: "se va cargando a futuro"), pero los tests/fixtures que asumían los 8 tickets seed de `shared-stores` (`openCount: 8`) hay que reescribirlos.
5. **Contadores `shared-stores`** — `incrementTickets/decrementTickets` quedan obsoletos: el conteo real sale de `COUNT(*)` sobre la tabla. Hay que retirarlos del flujo sin romper `getStats`.

## Rollback Plan

- El cambio de código revierte por revert del merge.
- La migration es **aditiva** (crea tabla nueva, no toca tablas existentes salvo agregar la back-relation `tickets` en `Client`/`Admin`). Down = `DROP TABLE "Ticket"`. No hay pérdida de datos preexistentes (no había tabla).
- Re-cablear `app.ts` de vuelta a `SplynxTicketAdapter` restaura el comportamiento previo si hiciera falta (el adapter se conserva).

## Affected Areas

### Backend
- `prisma/schema.prisma` (nuevo `model Ticket` + back-relations en `Client` y `Admin`)
- `prisma/migrations/<ts>_add_ticket_model/migration.sql` (nuevo — generado por el usuario)
- `src/domain/entities/ticket.ts`
- `src/domain/ports/TicketRepository.ts`
- `src/application/dto/tickets.dto.ts`
- `src/application/use-cases/ListTickets.ts` (extender)
- `src/application/use-cases/GetTicket.ts` (nuevo)
- `src/application/use-cases/UpdateTicketStatus.ts` (nuevo)
- `src/application/use-cases/CloseTicket.ts` (nuevo)
- `src/infrastructure/adapters/prisma/PrismaTicketRepository.ts` (nuevo)
- `src/infrastructure/adapters/in-memory/InMemoryTicketRepository.ts` (nuevo)
- `src/infrastructure/adapters/in-memory/shared-stores.ts` (retirar `incrementTickets/decrementTickets` del flujo)
- `src/infrastructure/http/routes/tickets.routes.ts` (reescritura del backing)
- `src/infrastructure/http/app.ts` (re-wiring)
- `src/__tests__/` (use cases + routes)

### Frontend (repo hermano — solo coordinación)
- Componente de info del cliente: botón/contador "Tickets (N)" → `GET /api/tickets?customerId=X`
- Página de listado de tickets filtrable por `customerId`
- Tipo `Ticket` del front alineado al nuevo DTO (`customerId`, `customerName`, `status` canónico)

## Success Criteria

- Existe `model Ticket` en `schema.prisma` con FK `customerId` → `Client` y migration aplicable.
- `GET /api/tickets?customerId=X` devuelve solo los tickets de ese cliente y un `total` correcto (mismo patrón que `GET /api/scheduling?customerId=X`).
- Crear un ticket con `customerId` lo persiste en Prisma y aparece en el conteo del cliente.
- Cerrar/cambiar estado de un ticket persiste en la columna real (no en un `Map`).
- `npm test` verde (use cases con InMemory, routes con supertest) y `tsc --noEmit` verde.
- Ningún use case ni route importa Prisma/Express desde `domain`/`application` (DIP estricto).
- El DTO de salida no expone la fila Prisma cruda.
- `app.ts` cablea `PrismaTicketRepository`; `SplynxTicketAdapter` queda descablear pero presente.
