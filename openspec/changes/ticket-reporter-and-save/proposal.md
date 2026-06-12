# Proposal: Reporter on Create + Unified Save in Ticket Detail (#48)

## Intent

Hoy el detalle de un ticket muestra **Reporter "—"** porque `Ticket` no persiste quién creó el ticket: no existe la columna `reporterId`, ni se estampa el usuario autenticado al crear (`POST /api/tickets` solo guarda `subject/description/customerId/priority/assigneeId`). No hay traza del creador.

A la vez, el panel **Detalles** del detalle aplica cada cambio (Asignado, Estado, Prioridad) con una mutación inmediata `onChange` por campo: el Estado vive en el header con su propio `PATCH /tickets/:id/status`, el Asignado en el sidebar con `PATCH /tickets/:id`, y la Prioridad es read-only. El usuario pidió un único botón **GUARDAR** que persista asignado + estado + prioridad en un solo save, con slot extensible para "área" (ítem #49, NO se implementa acá).

Esta propuesta corrige ambos problemas espejando el patrón ya archivado de TAREAS (`2026-05-28-task-detail-reporter-and-unified-save`), con dos divergencias justificadas: (1) `Ticket` denormaliza nombres por JOIN (`assigneeName`), así que `reporterName` se denormaliza igual — espejo de `assigneeName`, NO client-side como en TAREAS; (2) `Ticket` no tenía `reporterId` (TAREAS sí), por lo que REQUIERE una migración aditiva.

## Scope

### In Scope
- **BE schema**: `Ticket.reporterId String?` + relación `reporter RbacUser? @relation("TicketReporter")` + `@@index([reporterId])`. Migración aditiva (sin backfill: tickets viejos quedan `reporterId = null` → FE muestra "—").
- **BE entity/port/repos**: `Ticket.reporterId` + `Ticket.reporterName` (JOIN-derived, espejo de `assigneeName`). `CreateTicketData.reporterId?`. Repos Prisma + in-memory denormalizan `reporterName` igual que `assigneeName`.
- **BE create**: `POST /api/tickets` defaultea `reporterId` al `req.user.id` cuando el body no lo trae (espejo de `POST /:id/tasks` L266 que ya hace `reporterId: data.reporterId ?? req.user?.id ?? null`).
- **BE update unificado**: `PATCH /api/tickets/:id` pasa a aceptar `status` además de `{subject, description, priority, assigneeId}`. El `status` se valida contra el `TicketStatusCatalog` (case-insensitive, name canónico persistido, 422 si no existe) — exactamente como `PATCH /:id/status`. Esto habilita el save unificado del sidebar en una sola llamada.
- **BE DTO**: `TicketDto` expone `reporterId` + `reporterName` en todas las responses (list, getById, create, update).
- **FE tipo**: `Ticket` agrega `reporterId: string | null` y `reporterName: string | null` (deprecando el `reporter: string | null` legacy en favor de `reporterName`).
- **FE detalle**: el panel Detalles deja de mutar por campo. Reporter sigue siendo **display read-only** del nombre del creador. Asignado + Estado + Prioridad se editan con estado local (dirty tracking) y un único botón **GUARDAR** que persiste todo en un `updateTicket` (un solo `PATCH /tickets/:id` con `{assigneeId, status, priority}`). Warn-before-leave si hay cambios sin guardar. Slot extensible para "área" (#49) dejado preparado, sin implementar.

### Out of Scope
- **Ítem #49 (área)**: NO se implementa el campo "área". Solo se deja el form preparado para agregar un campo más.
- **Backfill de `reporterId`** en tickets existentes: no hay forma confiable de inferir el creador histórico. Quedan `null` → "—". Aceptado.
- **Cambiar el Reporter editable**: el usuario pidió "mostrar quién lo creó". Reporter es display read-only, no un select. El creador se estampa una vez en create.
- **Tocar `Ticket.id`/`customerId` como number en el FE** (deuda técnica preexistente: el BE manda string uuid). NO se toca.

## Capabilities

### New Capabilities
- None

### Modified Capabilities
- `tickets`: la creación de ticket SHALL estampar `reporterId` al usuario autenticado cuando el body no lo provee. `PATCH /:id` SHALL aceptar `status` validado contra el catálogo. Todas las responses SHALL incluir `reporterId` + `reporterName`.

## Approach

- **BE**: migración aditiva (`reporterId` nullable). Entity/port/DTO suman `reporterId`+`reporterName`. `PrismaTicketRepository` agrega `reporter: { select: { id, name } }` al `INCLUDE`, mapea `reporterName` en `toTicket`, y estampa `reporterId` en `create`. `InMemoryTicketRepository` resuelve `reporterName` via `seedAdmins` (mismo mapa que `assigneeName`). Route `POST /` agrega `reporterId: req.user?.id ?? null`. Route `PATCH /:id` lee `status` del body, lo valida con `ticketStatusRepo.getByName` (422 si no existe), y pasa el name canónico a `updateTicket`.
- **FE**: `Ticket` suma `reporterId`/`reporterName`. `TicketDetailPage` levanta estado local de `assigneeId/status/priority` inicializado del ticket, computa `isDirty`, y un `handleSave` que arma un `updateTicket.mutateAsync({ id, data: { assigneeId, status, priority } })` único. Botón GUARDAR en el panel. Estado deja de mutar inmediato en el header (se mueve al form unificado o se sincroniza). Reporter renderiza `ticket.reporterName ?? '—'`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modified | `Ticket.reporterId` + relación + index; back-relation en `RbacUser` |
| `prisma/migrations/<ts>_add_ticket_reporter/migration.sql` | Added | ALTER TABLE aditivo + index |
| `src/domain/entities/ticket.ts` | Modified | `reporterId` + `reporterName` |
| `src/domain/ports/TicketRepository.ts` | Modified | `CreateTicketData.reporterId?` |
| `src/infrastructure/adapters/prisma/PrismaTicketRepository.ts` | Modified | INCLUDE + toTicket + create estampan reporter |
| `src/infrastructure/adapters/in-memory/InMemoryTicketRepository.ts` | Modified | reporterName via seedAdmins |
| `src/application/dto/tickets.dto.ts` | Modified | `TicketDto` + `CreateTicketDto` con reporter |
| `src/infrastructure/http/routes/tickets.routes.ts` | Modified | POST estampa reporterId; PATCH /:id acepta status validado |
| `ipnext-frontend/src/types/ticket.ts` | Modified | `reporterId` + `reporterName` |
| `ipnext-frontend/src/pages/tickets/TicketDetailPage.tsx` (+ TicketHeader) | Modified | Save unificado + Reporter display |
| Tests BE + FE | Modified/Added | Ver tasks.md |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `req.user.id` no corresponde a un RbacUser (estado anómalo) y la FK revienta en create | Low | `reporterId` es FK `SetNull` nullable; por construcción `User.id == RbacUser.id` (JWT emitido del registro). Si fuese inválido, Prisma P2003 → 500, mismo trato que assigneeId hoy. |
| El select de Estado pierde la UX de mutación inmediata y confunde | Med | El save unificado es el patrón pedido explícitamente; el botón GUARDAR es el único punto de persistencia. Warn-before-leave evita pérdidas. |
| Migración rompe en prod por columna ya existente | Low | Migración aditiva `IF NOT EXISTS` no aplica en Prisma SQL; el SQL se genera con `migrate diff` desde el schema anterior, timestamp posterior a `20260630000000`. |
| FE `reporter` legacy usado en otros lados | Low | Se mantiene compat: el sidebar lee `reporterName`; `reporter` se deja deprecado hasta confirmar que nadie más lo consume. |

## Rollback Plan

Revertir los commits FE/BE por separado (`git revert`). La migración es aditiva — revertir el código deja la columna huérfana sin romper (nullable). Si se quiere limpiar, una migración inversa `DROP COLUMN reporterId`. El FE no rompe rutas viejas.

## Dependencies

- Ninguna externa. `req.user` ya disponible vía `authMiddleware` (cookie `auth_token`). `ticketStatusRepo` ya inyectado en el router.

## Success Criteria

- [ ] Crear un ticket nuevo via UI muestra al creador en "Reporter" del detalle.
- [ ] El panel Detalles tiene un único botón GUARDAR; asignado + estado + prioridad se persisten en una sola llamada.
- [ ] `PATCH /tickets/:id` acepta `status` y persiste el name canónico del catálogo (422 si no existe).
- [ ] Tickets viejos sin reporter siguen mostrando "—" sin romper.
- [ ] `npm test` (BE) + `npx tsc --noEmit` y `npx vitest run` + `npm run typecheck` (FE) verdes.
