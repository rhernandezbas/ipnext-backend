# Tasks — tickets-model

Backend-led. Espeja el patrón de `ScheduledTask`. STRICT TDD: test que falla primero, luego implementación. NO correr build. La migration la genera el usuario.

## Phase 0 — Confirmar decisiones abiertas (sin código)

- [ ] 0.1 Confirmar con el usuario el set canónico de `status` (`open|pending|closed`, sin `resolved`) y `priority` (`low|medium|high`). (design AD-3)
- [ ] 0.2 Confirmar que los replies de ticket quedan in-memory esta iteración (no se modela `TicketReply` todavía). (design AD-6)
- [ ] 0.3 Confirmar `assigneeId` como FK a `Admin` (vs texto libre). (design Open Q3)
- [ ] 0.4 Confirmar que la lista arranca vacía (sin seed de tickets). (design Open Q4)

## Phase 1 — Modelo + migration — depende de Phase 0

- [ ] 1.1 Editar `prisma/schema.prisma`: agregar `enum TicketStatus`, `enum TicketPriority` y `model Ticket` (campos + FK `customerId`→`Client` `onDelete:SetNull`, `assigneeId`→`Admin` `onDelete:SetNull`, `grCasoId @unique`, índices `customerId`/`status`/`assigneeId`). (design — Modelo)
- [ ] 1.2 Agregar back-relation `tickets Ticket[]` en `model Client` y `assignedTickets Ticket[] @relation("TicketAssignee")` en `model Admin`.
- [ ] 1.3 El usuario corre `npm run prisma:migrate` (`<ts>_add_ticket_model`) y `prisma generate`. ✅ **GATE: migration aplicada.**

## Phase 2 — Dominio: entidad + puerto — depende de Phase 1

- [ ] 2.1 (TEST) Test de tipos/forma de `Ticket`: tiene `customerId`, `customerName`, `assigneeId`, `assigneeName`, `status`/`priority` canónicos, `createdAt`/`updatedAt` ISO.
- [ ] 2.2 Reescribir `src/domain/entities/ticket.ts` con la nueva forma (status `'open'|'pending'|'closed'`, priority `'low'|'medium'|'high'`, FK + JOIN-derived). (design — Entidad)
- [ ] 2.3 Actualizar `src/domain/ports/TicketRepository.ts`: agregar `customerId?` a `ListTicketsQuery`; tipar `status`/`priority`; agregar `getById`, `update`, `close`; ajustar `CreateTicketData` (`customerId`/`assigneeId`). (design — Puerto)

## Phase 3 — Adapter in-memory (TDD base) — depende de Phase 2

- [ ] 3.1 (TEST) `InMemoryTicketRepository`: `create` persiste y devuelve con `customerName` resuelto; `list({customerId})` filtra; `getById`; `update`/`close` mutan estado.
- [ ] 3.2 Crear `src/infrastructure/adapters/in-memory/InMemoryTicketRepository.ts` implementando el puerto completo (espejo de `InMemorySchedulingRepository`). Verde.

## Phase 4 — Use cases — depende de Phase 3

- [ ] 4.1 (TEST) `ListTickets` reenvía `customerId` al repo y devuelve solo los de ese cliente (InMemory).
- [ ] 4.2 Extender `src/application/use-cases/ListTickets.ts` para pasar `customerId`.
- [ ] 4.3 (TEST) `GetTicket` devuelve el ticket o null.
- [ ] 4.4 Crear `src/application/use-cases/GetTicket.ts`.
- [ ] 4.5 (TEST) `UpdateTicketStatus` y `CloseTicket` persisten el nuevo estado.
- [ ] 4.6 Crear `src/application/use-cases/UpdateTicketStatus.ts` y `src/application/use-cases/CloseTicket.ts`.
- [ ] 4.7 Verificar `CreateTicket`/`GetTicketStats` siguen verdes contra el InMemory (ajustar fixtures si el shape cambió).

## Phase 5 — DTOs — depende de Phase 4

- [ ] 5.1 (TEST) `tickets.dto`: el filtro acepta `customerId`; el DTO de salida no expone campos de la fila Prisma cruda.
- [ ] 5.2 Actualizar `src/application/dto/tickets.dto.ts`: `customerId` en `ListTicketsQueryDto`; `CreateTicketDto` con `customerId`; nuevo `UpdateTicketDto`; DTO de output mapeado. (regla: no devolver entidad Prisma)

## Phase 6 — Adapter Prisma — depende de Phase 5

- [ ] 6.1 (TEST) Mapper `toTicket`: `customerName` viene SOLO del JOIN (`row.customer?.name ?? null`), null si no hay `customerId`; `assigneeName` del JOIN.
- [ ] 6.2 Crear `src/infrastructure/adapters/prisma/PrismaTicketRepository.ts`: `INCLUDE { customer:{select:{id,name}}, assignee:{select:{id,name}} }`, `where['customerId']` en `list`, `getById`, `create`, `update`, `close`, `getStats` (con `COUNT`). Espejo de `PrismaSchedulingRepository`. (design — Code Change Map)

## Phase 7 — Route — depende de Phase 6

- [ ] 7.1 (TEST) supertest: `GET /api/tickets?customerId=X` devuelve solo los del cliente y `total` correcto (repo InMemory inyectado).
- [ ] 7.2 (TEST) supertest: `POST /api/tickets` con `customerId` → 201 y aparece en el conteo del cliente.
- [ ] 7.3 (TEST) supertest: `PATCH /api/tickets/:id/status` (o `PATCH /:id`) persiste el estado vía el puerto (no override in-memory).
- [ ] 7.4 Reescribir `src/infrastructure/http/routes/tickets.routes.ts`: passthrough `?customerId` en `GET /`; `GET /:id`, `PATCH /:id`, `PATCH /:id/status`, `DELETE /:id` (o close) apoyados en use cases/puerto; retirar `ticketStatusStore`/`ticketEditsStore`/`ticketAssignmentStore`/`deletedTicketsStore` y `increment/decrementTickets`. Replies quedan in-memory (AD-6).
- [ ] 7.5 Mapear `status`/`priority` al vocabulario canónico en la validación de la route.

## Phase 8 — Wiring + limpieza — depende de Phase 7

- [ ] 8.1 (TEST) Test de composición: `app.ts` cablea `PrismaTicketRepository` y las rutas de tickets responden.
- [ ] 8.2 Editar `src/infrastructure/http/app.ts`: reemplazar `new SplynxTicketAdapter(splynxClient)` por `new PrismaTicketRepository(prisma)` en el wiring de tickets (líneas ~342,355-357); inyectar los nuevos use cases en `createTicketsRouter`.
- [ ] 8.3 Retirar `incrementTickets/decrementTickets` de `shared-stores.ts` (o dejarlos sin uso si otra parte los referencia — verificar con grep).
- [ ] 8.4 Conservar `SplynxTicketAdapter.ts` (descablear, no borrar).
- [ ] 8.5 `npm test` verde; `tsc --noEmit` verde. ✅ **VERIFY.**

## Phase 9 — Frontend (repo hermano — coordinación, lockstep)

- [ ] 9.1 (FE) Botón/contador "Tickets (N)" en la info del cliente → `GET /api/tickets?customerId={id}`, usar `total`. Espejo de "Tareas (N)".
- [ ] 9.2 (FE) Listado de tickets filtrable por `customerId`, navegable desde el botón.
- [ ] 9.3 (FE) Tipo `Ticket` del front alineado: `customerId`, `customerName`, `status` y `priority` canónicos; mapear español en presentación si aplica.
- [ ] 9.4 (FE) Migrar usos de `clientId`/`clientName` texto libre → `customerId`/`customerName`.

## Verification Checklist

- [ ] V.1 `model Ticket` existe en `schema.prisma` con FK `customerId`→`Client` y migration aplicable.
- [ ] V.2 `GET /api/tickets?customerId=X` devuelve solo los de ese cliente, `total` correcto.
- [ ] V.3 Crear/cerrar ticket persiste en la BD (no en `Map`).
- [ ] V.4 Ningún `domain`/`application` importa Prisma/Express (DIP).
- [ ] V.5 DTO de salida no expone fila Prisma cruda.
- [ ] V.6 `npm test` + `tsc --noEmit` verdes.
- [ ] V.7 "Tickets (N)" en el front funciona igual que "Tareas (N)".
