# Proposal: Ticket Status Catalog (tickets-status-catalog)

## Intent

Convert the hardcoded `enum TicketStatus { open pending closed }` on `model Ticket` into an editable catalog table `TicketStatus`, mirroring the `TaskPriority` pattern already established in the codebase. This unlocks UI-driven management of ticket statuses (add new statuses, assign colors, change sort order) without schema migrations.

## Scope

### In Scope
- New `model TicketStatus` in `prisma/schema.prisma` (id, name unique, color, weight, timestamps)
- Migration strategy: multi-step to preserve existing Ticket rows (documented in design.md)
- Seed: canonical values open/pending/closed with sensible defaults
- Domain: `TicketStatus` entity + `TicketStatusRepository` port
- Adapters: `PrismaTicketStatusRepository` + `InMemoryTicketStatusRepository`
- Use cases: `ListTicketStatuses`, `GetTicketStatus`, `CreateTicketStatus`, `UpdateTicketStatus`, `DeleteTicketStatus`
- DTO + Zod schemas in `tickets.dto.ts` (or new `ticketStatuses.dto.ts`)
- Route: `ticketStatuses.routes.ts` with full CRUD under `/api/tickets/statuses`
- Wiring in `app.ts`
- Tests: use-case tests with InMemory adapter, route tests with supertest

### Out of Scope
- Converting `Ticket.status` FK (Phase 2 — FK migration is destructive, must be user-run with live DB)
- Frontend changes
- TicketReply model
- Any change to TicketPriority

## Capabilities

### New Capabilities
- `ticket-status-catalog`: Editable CRUD catalog for ticket statuses with name, color, and weight (sort order).

### Modified Capabilities
- None in Phase 1. Ticket.status remains the enum string for now; the catalog coexists until the FK migration is executed by the user with a live DB.

## Approach

Mirror `TaskPriority` exactly:
1. SDD artifacts (this change)
2. Domain layer: entity + port + errors
3. Application layer: 5 use cases + DTOs
4. Infrastructure layer: InMemory + Prisma adapters + route
5. Wire in app.ts minimally
6. Tests: TDD (red first), use cases + routes

**NOTE ON MIGRATION**: The `Ticket.statusId` FK conversion is a Phase 2 operation requiring a live DB. Phase 1 delivers the catalog (CRUD) with the schema model added but WITHOUT breaking the existing enum on `Ticket`. The enum stays until the user runs the multi-step migration described in design.md.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Migration drops Ticket rows | High | Multi-step approach in design.md; user must review generated migration SQL before running |
| Name collision with domain type TicketStatus (currently a type alias) | Med | Rename domain type alias to TicketStatusName; new entity is TicketStatusCatalog... or reuse TicketStatus carefully with clear JSDoc |
| Existing ticket tests break | Low | Ticket.status stays as enum string in Phase 1; no functional change to existing paths |
