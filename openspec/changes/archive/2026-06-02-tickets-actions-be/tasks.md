# Tasks: tickets-actions-be (v2)

> Stacks on: `contratos-naming-be` (contractId end-state). All new code uses `contractId`, never `serviceId`.
> TDD mode: red → green → refactor.

---

## Phase 0 — Schema & migration

- [ ] **T-01** Add `ticketId String?` + FK (`onDelete: SetNull`) + `@@index([ticketId])` to `ScheduledTask` in `prisma/schema.prisma`
- [ ] **T-02** Add `tasks ScheduledTask[]` back-relation to `Ticket` model in `prisma/schema.prisma`
- [ ] **T-03** Write migration SQL `prisma/migrations/20260602000000_ticket_task_fk/migration.sql`:
  - `ALTER TABLE "ScheduledTask" ADD COLUMN "ticketId" TEXT;`
  - `ALTER TABLE "ScheduledTask" ADD CONSTRAINT "ScheduledTask_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;`
  - `CREATE INDEX "ScheduledTask_ticketId_idx" ON "ScheduledTask"("ticketId");`

---

## Phase 1 — Domain layer

- [ ] **T-04** Add `ticketId: string | null` and `ticketSubject: string | null` to `ScheduledTask` interface in `src/domain/entities/scheduling.ts`
- [ ] **T-05** Add `'ticket'` to `ReferenceKind` union in `src/domain/errors/scheduling.ts`
- [ ] **T-06** Add `ticketSubject` to the `Omit` list in `CreateTaskInput` in `src/domain/ports/SchedulingRepository.ts` (derived field — not an input; `ticketId` remains as input)
- [ ] **T-07** Verify `TicketNotFoundError` exists in `src/domain/errors/ticket.ts` (or equivalent); create it there if absent

---

## Phase 2 — Application layer

- [ ] **T-08** Write test `src/__tests__/application/CreateTask.ticketId.test.ts` (RED):
  - happy path: ticketId provided, ticketLookup finds it → task created with ticketId
  - sad path: ticketId provided, ticketLookup returns null → throws ReferenceNotFoundError('ticket')
  - no-ticketId path: ticketLookup never called when ticketId is null
- [ ] **T-09** Extend `CreateTask.ts`: add optional `private readonly ticketLookup?: EntityLookup` as last constructor parameter; validate `data.ticketId` last in FK chain when non-null (GREEN for T-08)
- [ ] **T-10** Write DTO file `src/application/dto/ticket-task.dto.ts` with `CreateTaskFromTicketSchema` (see design.md §5)
- [ ] **T-11** Write test `src/__tests__/application/CreateTaskFromTicket.test.ts` (RED):
  - happy path: ticket exists, body valid → delegates to CreateTask, returns task with ticketId + ticketSubject
  - sad path: ticket not found → throws TicketNotFoundError
  - ticketId is NOT overridable from input (always from path param)
- [ ] **T-12** Write `src/application/use-cases/CreateTaskFromTicket.ts` (GREEN for T-11; see design.md §4)

---

## Phase 3 — Infrastructure / adapters

- [ ] **T-13** Add `ticket: { select: { id: true, subject: true } }` to `INCLUDE` const in `PrismaSchedulingRepository.ts`
- [ ] **T-14** Add `ticketId: row.ticketId ?? null` and `ticketSubject: row.ticket?.subject ?? null` to `toTask()` in `PrismaSchedulingRepository.ts`
- [ ] **T-15** Add `ticketId: null, ticketSubject: null` to `NEW_FIELDS_DEFAULTS` in `InMemorySchedulingRepository.ts`
- [ ] **T-16** Persist `ticketId` from `CreateTaskInput` in `InMemorySchedulingRepository.createTask()`
- [ ] **T-17** Add `ticketSubjects: Map<string, string>` side-store + `seedTicketSubject(ticketId: string, subject: string)` helper to `InMemorySchedulingRepository`; derive `ticketSubject` in `getTask()` / `listTasks()` from the map (same pattern as `projectNames`)

---

## Phase 4 — HTTP layer

- [ ] **T-18** Write route test `src/__tests__/infrastructure/tickets-tasks.route.test.ts` (RED):
  - `POST /api/tickets/:id/tasks` 201 with valid body (contractId, priority, estimatedHours) → returns task with ticketId + ticketSubject
  - `POST /api/tickets/:id/tasks` 404 when ticket not found
  - `POST /api/tickets/:id/tasks` 400 when contractId missing from body
  - `POST /api/tickets/:id/tasks` 404 when contractId invalid (contract not found)
- [ ] **T-19** Add `createTaskFromTicket: CreateTaskFromTicket` parameter to `createTicketsRouter` in `tickets.routes.ts`
- [ ] **T-20** Mount `POST /:id/tasks` handler in `tickets.routes.ts` BEFORE existing `/:id` routes (no shadowing risk since path length differs, but explicit ordering for clarity):
  - Parse body with `CreateTaskFromTicketSchema.safeParse` → 400 on failure
  - Resolve stageId default via `stageRepo` (same pattern as scheduling.routes.ts lines 285-298)
  - Call `createTaskFromTicket.execute(...)` with `ticketId` from `req.params.id` and body fields
  - Handle `TicketNotFoundError` → 404
  - Handle `ReferenceNotFoundError` → 404 with appropriate code
  - Handle `StageNotFoundError` → 500 (same as scheduling.routes)
  - 201 + task DTO on success
- [ ] **T-21** Add `stageRepo?: StageRepository` parameter to `createTicketsRouter` (needed for default stage resolution in T-20)
- [ ] **T-22** Wire `CreateTaskFromTicket` in `app.ts`:
  - Instantiate: `const createTaskFromTicket = new CreateTaskFromTicket(ticketAdapter, createTask);`
  - Pass `createTaskFromTicket` and `stageRepo` into the `createTicketsRouter` call
  - Add `'ticket': 'TICKET_NOT_FOUND'` to `REFERENCE_TO_CODE` map in `tickets.routes.ts` (or handle inline)

---

## Phase 5 — Verification

- [ ] **T-23** Run full test suite (`npm test`) — all existing tests green; new tests green; no regressions on scheduling or tickets suites
- [ ] **T-24** TypeScript compile check (`tsc --noEmit`) — zero errors
- [ ] **T-25** Verify `POST /api/scheduling` (existing path) still works correctly — `ticketLookup` is never called, no overhead

---

## Dependency order

```
T-01,T-02,T-03   (schema)
    ↓
T-04,T-05,T-06,T-07   (domain)
    ↓
T-08 → T-09   (CreateTask extension, TDD)
T-10           (DTO, independent)
T-11 → T-12   (CreateTaskFromTicket, TDD)
    ↓
T-13,T-14,T-15,T-16,T-17   (repositories)
    ↓
T-18 → T-19,T-20,T-21,T-22   (routes + app.ts, TDD)
    ↓
T-23,T-24,T-25   (verify)
```
