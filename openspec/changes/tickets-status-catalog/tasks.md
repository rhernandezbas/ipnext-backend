# Tasks: tickets-status-catalog

## Phase 1 — Catalog CRUD (safe, no migration risk)

### T-1: schema.prisma — add TicketStatus model
- [ ] Add `model TicketStatus` with id/name/color/weight/timestamps (mirror TaskPriority)
- [ ] Keep existing `enum TicketStatus` + `Ticket.status` UNTOUCHED
- [ ] Add JSDoc comment explaining the two-phase migration

### T-2: Domain layer
- [ ] Create `src/domain/entities/ticketStatusCatalog.ts` — TicketStatusCatalog interface
- [ ] Add errors to `src/domain/errors/tickets.ts` (new file): TicketStatusNotFoundError, TicketStatusNameConflictError, TicketStatusInUseError
- [ ] Create `src/domain/ports/TicketStatusRepository.ts` — mirror TaskPriorityRepository

### T-3: Tests (RED first — TDD)
- [ ] Write `src/__tests__/application/TicketStatus.test.ts` (use cases with InMemory)
- [ ] Write `src/__tests__/infrastructure/ticketStatuses.routes.test.ts` (supertest)

### T-4: Application layer
- [ ] `src/application/use-cases/ListTicketStatuses.ts`
- [ ] `src/application/use-cases/GetTicketStatus.ts`
- [ ] `src/application/use-cases/CreateTicketStatus.ts`
- [ ] `src/application/use-cases/UpdateTicketStatus.ts` (name conflict: must NOT collide with existing UpdateTicketStatus for tickets — different use case)
- [ ] `src/application/use-cases/DeleteTicketStatus.ts`
- [ ] Add Zod schemas to `src/application/dto/tickets.dto.ts` or new file

### T-5: Infrastructure — adapters
- [ ] `src/infrastructure/adapters/in-memory/InMemoryTicketStatusRepository.ts`
- [ ] `src/infrastructure/adapters/prisma/PrismaTicketStatusRepository.ts`

### T-6: Infrastructure — route
- [ ] `src/infrastructure/http/routes/ticketStatuses.routes.ts`
- [ ] Endpoints: GET /statuses, GET /statuses/:id, POST /statuses, PUT /statuses/:id, DELETE /statuses/:id

### T-7: Wire in app.ts
- [ ] Import PrismaTicketStatusRepository + 5 use-cases
- [ ] Mount route BEFORE existing tickets router

### T-8: Seed
- [ ] Add TicketStatus seed in `prisma/seed.ts` (open/pending/closed with colors+weights)

### T-9: Tests GREEN + typecheck
- [ ] `npm test` all pass
- [ ] `npx tsc --noEmit` clean
- [ ] Commit: `feat(tickets): add TicketStatus editable catalog (Phase 1 — table + CRUD)`

## Phase 2 (future — requires live DB, user-run)

- Modify schema.prisma: add statusId FK on Ticket, remove enum
- Run multi-step migration per design.md (3 separate migrate dev calls)
- Update ticket entity, use-cases, routes to use statusId/FK relation
- Update existing ticket tests
