# Tasks: Reporter on Create + Unified Save in Ticket Detail (#48)

Strict TDD: test que falla PRIMERO (RED) → implementación (GREEN) → refactor. `git add` por path explícito.

## BE — Backend (worktree: ipnext-backend/.claude/worktrees/ticket-reporter-be)

### T1 — Schema + migración aditiva (reporterId)
- [ ] T1.1 `prisma/schema.prisma`: agregar a `model Ticket`: `reporterId String?` + `reporter RbacUser? @relation("TicketReporter", fields: [reporterId], references: [id], onDelete: SetNull)` + `@@index([reporterId])`.
- [ ] T1.2 `model RbacUser`: back-relation `reportedTickets Ticket[] @relation("TicketReporter")`.
- [ ] T1.3 Generar migración: `git show HEAD:prisma/schema.prisma > /tmp/before.prisma && npx prisma migrate diff --from-schema /tmp/before.prisma --to-schema prisma/schema.prisma --script`. Guardar en `prisma/migrations/<ts>_add_ticket_reporter/migration.sql` (ts > 20260630000000). Verificar: solo ADD COLUMN + FK + INDEX, sin BEGIN/COMMIT, sin DROP.
- [ ] T1.4 `npx prisma generate` (para que el client tipe `reporter`; el repo igual usa `as any`).

### T2 — Entity + Port (RED→GREEN)
- [ ] T2.1 `src/domain/entities/ticket.ts`: agregar `reporterId: string | null` + `reporterName: string | null` a la interface `Ticket`.
- [ ] T2.2 `src/domain/ports/TicketRepository.ts`: agregar `reporterId?: string | null` a `CreateTicketData`.

### T3 — InMemoryTicketRepository (RED→GREEN)
- [ ] T3.1 Test RED: `src/__tests__/infrastructure/...` — crear ticket con `reporterId` seedeado en admins → `reporterName` resuelto; sin reporterId → null. (Reusar el patrón de assigneeName.)
- [ ] T3.2 GREEN: `InMemoryTicketRepository.create`: resolver `reporterName` desde `this.admins` (mismo map que assignee). Setear `reporterId`/`reporterName` en el objeto Ticket. `update` preserva reporter (no se edita).

### T4 — PrismaTicketRepository (RED→GREEN)
- [ ] T4.1 Test RED: `PrismaTicketRepository.toTicket.test.ts` — row con `reporter: { id, name }` → `reporterId`/`reporterName` mapeados; sin reporter → null.
- [ ] T4.2 GREEN: `INCLUDE` agrega `reporter: { select: { id: true, name: true } }`; `toTicket` mapea `reporterId: row.reporterId ?? null` + `reporterName: row.reporter?.name ?? null`; `create` agrega `...(data.reporterId != null && { reporterId: data.reporterId })`.

### T5 — DTO
- [ ] T5.1 `src/application/dto/tickets.dto.ts`: `TicketDto` suma `reporterId`/`reporterName`; `CreateTicketDto` suma `reporterId?`.

### T6 — Routes: POST estampa reporterId (RED→GREEN)
- [ ] T6.1 Test RED en `tickets.routes.new.test.ts`: `seedAdmins([{id:'1',name:'Admin Uno'}])` (authProvider devuelve id '1'). POST sin reporterId → 201, `res.body.reporterId === '1'`, `res.body.reporterName === 'Admin Uno'`. POST con reporterId explícito → gana el del body.
- [ ] T6.2 GREEN: `POST /` lee `reporterId` del body; pasa `reporterId: reporterId ?? req.user?.id ?? null` a `createTicket.execute`.

### T7 — Routes: PATCH /:id acepta status validado (RED→GREEN)
- [ ] T7.1 Test RED en `tickets.routes.new.test.ts`: PATCH /:id con `{status:'pending', assigneeId:'1', priority:'high'}` → 200, status canónico, los 3 campos persistidos (verificar via `repo.getById`). PATCH con status inexistente → 422 `TICKET_STATUS_NOT_FOUND` y ticket SIN cambios (assigneeId/priority NO aplicados). PATCH sin status → comportamiento previo intacto.
- [ ] T7.2 GREEN: en `PATCH /:id`, leer `status` del body. Si viene: `ticketStatusRepo.getByName(status)` → si null, 422 `TICKET_STATUS_NOT_FOUND` ANTES de cualquier update; si existe, agregar `status: catalogEntry.name` al payload de `updateTicket`. Validar status PRIMERO, luego construir el resto del payload.

### T8 — Gate BE
- [ ] T8.1 `npm test` verde (suite completa).
- [ ] T8.2 `npx tsc --noEmit` verde.

## FE — Frontend (worktree: ipnext-frontend/.claude/worktrees/ticket-reporter-fe)

### T9 — Tipo Ticket
- [ ] T9.1 `src/types/ticket.ts`: agregar `reporterId: string | null` + `reporterName: string | null`. Mantener `reporter` (deprecado) hasta confirmar consumidores.

### T10 — TicketDetailPage: Reporter display + save unificado (RED→GREEN)
- [ ] T10.1 Test RED `TicketDetailPage.test.tsx`: (a) mock con `reporterName:'Juan Creador'` → render 'Juan Creador' en Reporter; `reporterName:null` → '—'. (b) cambiar asignado + estado + prioridad y click GUARDAR → UN solo `updateTicket.mutateAsync` con `{id, data:{assigneeId, status, priority}}`.
- [ ] T10.2 GREEN: `TicketDetailPage`:
  - Estado local `{assigneeId, status, priority}` inicializado del ticket (`useEffect` al cargar).
  - `isDirty` = algún campo difiere del ticket original.
  - Reporter: `<span>{ticket.reporterName ?? '—'}</span>` (read-only).
  - Asignado/Estado/Prioridad: selects controlados por estado local (NO mutación inmediata).
  - Botón GUARDAR: `updateTicket.mutateAsync({ id, data: { assigneeId, status, priority } })`. Toast success/error. Reset dirty al guardar.
  - Warn-before-leave (`beforeunload`) si `isDirty` (espejo de SchedulingTaskDetailPage).
  - Slot extensible: dejar el bloque de campos preparado para sumar "área" (#49) sin reestructurar — comentario `// #49: área aquí`.
- [ ] T10.3 `TicketHeader.tsx`: el select de Estado deja de mutar inmediato; lo controla el estado local del page (prop `value` + `onChange` que setea estado local, no muta). Si es más limpio, mover el select de Estado al panel Detalles.
- [ ] T10.4 `useUpdateTicket` (si hace falta): asegurar que el body tipa `{ assigneeId?, status?, priority?, subject?, description? }` y pega `PATCH /tickets/:id`. Corregir el tipo legacy `message?` → `description?`.

### T11 — Gate FE
- [ ] T11.1 `npx vitest run` verde (suite completa).
- [ ] T11.2 `npm run typecheck` verde.

## Cierre
- [ ] C1 — Commit BE (path explícito; `git show --stat HEAD` vs lista esperada). NO push, NO main.
- [ ] C2 — Commit FE (path explícito; verificar stat). NO push, NO main.
- [ ] C3 — Verify: ambos gates verdes; wire contract respetado campo por campo.
- [ ] C4 — mem_save apply-progress + hallazgos.
