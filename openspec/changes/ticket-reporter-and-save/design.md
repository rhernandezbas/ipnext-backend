# Design: Reporter on Create + Unified Save in Ticket Detail (#48)

## Technical Approach

Espejo del cambio archivado de TAREAS (`2026-05-28-task-detail-reporter-and-unified-save`) con DOS divergencias justificadas, porque el modelo de TICKETS es distinto al de TAREAS:

1. **TAREAS resolvió `reporterName` client-side** (el page ya tenía el listado de admins). **TICKETS denormaliza `reporterName` en BE** porque la entity `Ticket` YA denormaliza `assigneeName` via JOIN (`assignee.name` de `RbacUser`). Agregar `reporterName` es espejo exacto de `assigneeName` — no introduce un patrón nuevo, sigue el existente. Resolverlo client-side acá sería la inconsistencia.

2. **TAREAS no necesitó migración** (`ScheduledTask.reporterId` ya existía). **TICKETS requiere migración aditiva** porque `Ticket` no tiene `reporterId`.

El save unificado del FE NO necesita un endpoint nuevo: `PATCH /tickets/:id` ya acepta `assigneeId`/`priority`; solo se le agrega `status` (validado contra el catálogo, igual que `PATCH /:id/status`). Un único `PATCH` persiste los tres campos.

## Architecture Decisions

### Decision 1: `reporterId` default en el route handler, NO en `CreateTicket`

| Opción | Tradeoff | Decisión |
|--------|----------|----------|
| Route handler (`tickets.routes.ts`) lee `req.user.id` y lo pasa como `reporterId` default | HTTP context queda en infra; use case sigue puro | ✅ Elegido |
| `CreateTicket` recibe un port `getCurrentUserId` | Mezcla concerns: el use case conocería auth context | ❌ Rechazado |

**Rationale**: hexagonal estricto — `application/` no conoce primitivas HTTP. `req.user` es de infra. Idéntico al patrón ya vigente en `POST /:id/tasks` (L266). `CreateTicket` hoy es un passthrough puro (`return this.repo.create(data)`); se mantiene así, solo `CreateTicketData` suma `reporterId?`.

### Decision 2: `reporterName` denormalizado en BE (espejo de `assigneeName`), NO client-side

| Opción | Tradeoff | Decisión |
|--------|----------|----------|
| `PrismaTicketRepository.INCLUDE` agrega `reporter: { select: { id, name } }`; `toTicket` mapea `reporterName` | 1 línea en INCLUDE + 1 en toTicket; consistente con assignee | ✅ Elegido |
| Resolver `reporterId → name` en el FE con `useRbacUsers` (como TAREAS) | Inconsistente: assignee se resuelve server-side, reporter client-side; dos fuentes de verdad para lo mismo | ❌ Rechazado |

**Rationale**: la entity `Ticket` ya carga `assigneeName` por JOIN. Romper la simetría sería deuda. El FE ya recibe `assigneeName` listo; recibir `reporterName` igual es cero fricción.

### Decision 3: `status` en `PATCH /:id` se valida en el route (catálogo), no en el repo

| Opción | Tradeoff | Decisión |
|--------|----------|----------|
| El route valida `status` con `ticketStatusRepo.getByName` (422 si no existe) ANTES de llamar `updateTicket`, y pasa el name canónico | Validación + name canónico en un solo lugar, idéntico a `PATCH /:id/status`; el repo ya resuelve name→id case-insensitive | ✅ Elegido |
| Dejar que el repo (`resolveStatusId`) tire `TicketStatusUnknownError` y mapear a 422 en el catch | El repo ya hace case-insensitive name→id, pero NO devuelve el name canónico para la respuesta; y el 422 quedaría enredado con otros errores | ❌ Rechazado |

**Rationale**: lección #46 — nunca whitelist hardcodeada; el catálogo es la fuente de verdad. El route ya tiene `ticketStatusRepo` inyectado y el patrón exacto en `PATCH /:id/status` (L146-156): `getByName` → 422 si null → pasar `catalogEntry.name` (canónico). Reusar ese patrón. CRÍTICO: validar el status ANTES de cualquier persistencia, para no aplicar parcialmente `assigneeId`/`priority` cuando el status es inválido (REQ-TICKET-UPDATE-2).

### Decision 4: Reporter es display read-only en el FE, NO un select

| Opción | Tradeoff | Decisión |
|--------|----------|----------|
| Reporter renderiza `ticket.reporterName ?? '—'` (read-only) | El creador se estampa una vez en create; no se cambia después | ✅ Elegido |
| Reporter editable como un select de RbacUsers | El usuario pidió "mostrar quién lo creó", no reasignar el creador; reescribir el creador rompe la traza | ❌ Rechazado |

### Decision 5: FE estado local + un solo `updateTicket`, Estado deja de mutar inmediato

| Opción | Tradeoff | Decisión |
|--------|----------|----------|
| `TicketDetailPage` levanta estado local `{assigneeId, status, priority}` del ticket; `isDirty`; botón GUARDAR hace UN `updateTicket.mutateAsync({ id, data })` | Patrón pedido; un solo viaje al API; warn-before-leave | ✅ Elegido |
| Mantener mutación inmediata por campo + agregar botón GUARDAR redundante | Doble fuente de persistencia, confuso | ❌ Rechazado |

**Rationale**: espejo de `SchedulingTaskDetailPage` (dirty flags + `handleFormSubmit` con `mutateAsync` batch + beforeunload). El select de Estado se mueve del header al panel editable (o se controla con estado local sincronizado) para que GUARDAR sea el único punto de persistencia. Slot "área" (#49): el form queda preparado para sumar un campo más sin reestructurar.

## Wire Contract (BE ↔ FE, campo por campo — lección W6)

### `POST /api/tickets` (create) — request body
```
{ subject: string (req), description: string (req),
  customerId?: string|null, priority?: 'low'|'medium'|'high',
  assigneeId?: string|null, reporterId?: string|null }   // reporterId NUEVO, opcional
```
Si `reporterId` ausente/null → BE estampa `req.user.id`.

### `PATCH /api/tickets/:id` (unified save) — request body
```
{ subject?: string, description?: string,
  priority?: 'low'|'medium'|'high',
  assigneeId?: string|null,
  status?: string }                                       // status NUEVO en este endpoint
```
- `status` validado contra catálogo (case-insensitive). 422 `TICKET_STATUS_NOT_FOUND` si no existe.
- Status persistido como name CANÓNICO del catálogo (no la casing enviada).
- Sin `status` → comportamiento idéntico al actual.

### Response DTO (todas las rutas de ticket) — `TicketDto`
```
{ id: string, sequenceNumber: number, subject: string, description: string,
  status: string, priority: 'low'|'medium'|'high',
  customerId: string|null, customerName: string|null,
  assigneeId: string|null, assigneeName: string|null,
  reporterId: string|null, reporterName: string|null,    // AMBOS NUEVOS
  grCasoId: string|null, createdAt: string, updatedAt: string,
  tasks?: [...] }
```

### FE consumo
- `Ticket.reporterId: string|null` + `Ticket.reporterName: string|null` (nuevos). `reporter: string|null` legacy deprecado.
- Sidebar Reporter: `ticket.reporterName ?? '—'`.
- Save unificado: `updateTicket.mutateAsync({ id, data: { assigneeId, status, priority } })` (un solo PATCH).

## Data Flow

```
Backend (creación):
  POST /api/tickets ── reporterId ?? req.user?.id ?? null ──→ CreateTicket ──→ repo.create
                                                                                  │ INCLUDE reporter
                                                                                  ▼ toTicket → reporterName

Backend (save unificado):
  PATCH /api/tickets/:id ──┬─ status? ──→ ticketStatusRepo.getByName ──(422 si null)
                           │                     │ canonical name
                           └─────────────────────┴──→ updateTicket.execute(id, {assigneeId,status,priority})

Frontend (detalle):
  TicketDetailPage estado local {assigneeId,status,priority} (init del ticket)
        │ isDirty
        ▼ GUARDAR
  updateTicket.mutateAsync({ id, data })  ── un solo PATCH ──→ invalidate ['ticket',id]
  Reporter: <span>{ticket.reporterName ?? '—'}</span>  (read-only)
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modify | `Ticket.reporterId String?` + `reporter RbacUser? @relation("TicketReporter", fields:[reporterId], references:[id], onDelete: SetNull)` + `@@index([reporterId])`; `RbacUser` back-relation `reportedTickets Ticket[] @relation("TicketReporter")` |
| `prisma/migrations/<ts>_add_ticket_reporter/migration.sql` | Add | `ALTER TABLE "Ticket" ADD COLUMN "reporterId" TEXT;` + FK + `CREATE INDEX`. Generado con `migrate diff`. Timestamp > 20260630000000. |
| `src/domain/entities/ticket.ts` | Modify | `reporterId: string\|null` + `reporterName: string\|null` |
| `src/domain/ports/TicketRepository.ts` | Modify | `CreateTicketData.reporterId?: string\|null` |
| `src/infrastructure/adapters/prisma/PrismaTicketRepository.ts` | Modify | INCLUDE `reporter`; `toTicket` → reporterId/reporterName; `create` estampa `reporterId` |
| `src/infrastructure/adapters/in-memory/InMemoryTicketRepository.ts` | Modify | `create` resuelve `reporterName` via `admins` map (seedAdmins) |
| `src/application/dto/tickets.dto.ts` | Modify | `TicketDto` + `CreateTicketDto` con reporter |
| `src/infrastructure/http/routes/tickets.routes.ts` | Modify | POST estampa `reporterId: req.user?.id`; PATCH /:id lee `status`, valida catálogo, pasa canónico |
| `ipnext-frontend/src/types/ticket.ts` | Modify | `reporterId` + `reporterName` |
| `ipnext-frontend/src/pages/tickets/TicketDetailPage.tsx` | Modify | Estado local + GUARDAR unificado; Reporter `reporterName` |
| `ipnext-frontend/src/pages/tickets/TicketDetailPage/components/TicketHeader.tsx` | Modify | Estado deja de mutar inmediato (controlado por estado local del page) |
| BE tests | Add/Modify | `tickets.routes.new.test.ts` (reporter on create, status en PATCH /:id, 422), `InMemoryTicketRepository` reporter, `PrismaTicketRepository.toTicket.test.ts` reporter |
| FE tests | Add/Modify | `TicketDetailPage.test.tsx` (Reporter render, botón GUARDAR, un solo updateTicket) |

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| BE integration | REQ-TICKET-CREATE-1/2 | supertest sobre `tickets.routes.ts`; `authProvider.getSession` devuelve `{id:'1'}`; `repo.seedAdmins([{id:'1',name:'Admin'}])`; assert `reporterId==='1'` + `reporterName==='Admin'`. RED→GREEN. |
| BE integration | REQ-TICKET-UPDATE-1/2/3 | PATCH /:id con `{status,assigneeId,priority}` → 200 + name canónico + campos persistidos. Status inexistente → 422 sin tocar el ticket. Sin status → comportamiento previo. |
| BE unit | reporterName JOIN | `InMemoryTicketRepository` con seedAdmins; `PrismaTicketRepository.toTicket` con row.reporter. |
| FE unit | Reporter display | Vitest: `reporterName` en mock → render del nombre; `null` → '—'. |
| FE unit | Save unificado | Vitest: cambiar asignado+estado+prioridad, click GUARDAR → UN solo `updateTicket.mutateAsync` con los 3 campos. |
| Gate | suite completa | BE `npm test` + `npx tsc --noEmit`; FE `npx vitest run` + `npm run typecheck`. AMBOS worktrees. |

## Migration / Rollout

Migración aditiva — `reporterId` nullable, sin backfill. Tickets nuevos obtienen reporter; viejos quedan null. SQL generado con:
```
git show HEAD:prisma/schema.prisma > /tmp/before.prisma
npx prisma migrate diff --from-schema /tmp/before.prisma --to-schema prisma/schema.prisma --script
```
NUNCA `migrate dev`. Sin `BEGIN/COMMIT` en el SQL. Timestamp posterior a `20260630000000`. Despliegue en dos commits independientes (BE primero, FE después).

## Open Questions

- Ninguna. El status en PATCH /:id reusa el patrón validado de PATCH /:id/status; el reporter espeja assignee.
