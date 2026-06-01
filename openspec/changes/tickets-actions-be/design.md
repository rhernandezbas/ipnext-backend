# Design: tickets-actions-be (v2 — rebuilt on origin/main)

> Stack: Node + TypeScript + Express 4 + Prisma 7 + PostgreSQL  
> Base: origin/main (latest = `20260601120000_iclass_closure_to_inventory`)  
> Stacks ON TOP of: `contratos-naming-be` (which renames `ScheduledTask.serviceId` → `contractId`)  
> Migration slot: `20260602000000_ticket_task_fk` (first after contratos-naming-be's migration)

---

## 1. Schema delta — `ScheduledTask += ticketId`

### 1.1 Changes to `prisma/schema.prisma`

**On `ScheduledTask`** — add after `grOrdenId`:

```prisma
ticketId   String?
ticket     Ticket?  @relation(fields: [ticketId], references: [id], onDelete: SetNull)

@@index([ticketId])
```

**On `Ticket`** — add back-relation (no new column, Prisma relation only):

```prisma
tasks      ScheduledTask[]
```

**Why SetNull**: a ticket can be deleted without cascading task deletion. The task remains and becomes "orphaned from its origin ticket" — not deleted.

**Why 1:N not 1:1**: a ticket can spawn multiple tasks (e.g. first visit, return visit). The back-relation `Ticket.tasks` is the aggregate.

### 1.2 Migration

File: `prisma/migrations/20260602000000_ticket_task_fk/migration.sql`

```sql
-- AddColumn: ticketId on ScheduledTask
ALTER TABLE "ScheduledTask" ADD COLUMN "ticketId" TEXT;

-- FK constraint
ALTER TABLE "ScheduledTask"
  ADD CONSTRAINT "ScheduledTask_ticketId_fkey"
  FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Index
CREATE INDEX "ScheduledTask_ticketId_idx" ON "ScheduledTask"("ticketId");
```

**Ordering guarantee**: this migration timestamp (20260602000000) is AFTER:
- origin's last: `20260601120000_iclass_closure_to_inventory`
- contratos-naming-be's migration (which must also be > 20260601120000 — exact timestamp TBD by that branch, but ours is always after it in the chain)

---

## 2. Architecture decisions

### AD-1 — `CreateTaskFromTicket` delegates to `CreateTask`

`CreateTaskFromTicket` is a thin use case. It:
1. Reads the ticket via `TicketRepository.getById(ticketId)` — clean 404 if missing
2. Constructs `CreateTaskInput` from the ticket's fields (title, description, customerId, assigneeId) plus `contractId` from the request body and `ticketId` from the route path
3. Calls `this.createTask.execute(input)` — the full FK-validation chain runs exactly once, inside the existing `CreateTask` use case

This is NOT a repo call bypass. `CreateTask` validates customer, contract, partner, project, reporter, assignee, watchers, AND ticket. `CreateTaskFromTicket` just assembles the input.

### AD-2 — `contractId` is REQUIRED in `POST /api/tickets/:id/tasks` body

Origin's `CreateTask` hard-requires `customerId` + `contractId` (post-contratos rename). The `Ticket` model has no `contractId` (a ticket relates to a client, not a specific contract). Therefore:

- The FE shows a contract picker from the client's contracts when creating a task from a ticket
- `contractId` MUST come from the request body — it cannot be inferred from the ticket
- The endpoint validates: `{ contractId: z.string().min(1), stageId?: z.string(), priority: z.string().min(1), estimatedHours: z.number() }` — these are the fields that cannot be derived from the ticket

**Prefilled from ticket** (body overrides ignored for these):
- `title` ← `ticket.subject`
- `description` ← `ticket.description`
- `customerId` ← `ticket.customerId`
- `assigneeId` ← `ticket.assigneeId`
- `ticketId` ← path param `:id` (NEVER body-overridable — prevents mislink)

**From body (required)**:
- `contractId` — user picks from client's contracts
- `priority` — required by `CreateTask`
- `estimatedHours` — required by `CreateTask`
- `stageId` — optional; route resolves default via `stageRepo.getDefaultWorkflowStageByLegacyStatus('pending')` (same helper as `POST /api/scheduling`)

**Optional body fields** (passed through to `CreateTask`):
- `stageId`, `projectId`, `address`, `coordinates`, `category`, `notes`, `startDate`, `endDate`, `partnerId`, `reporterId`, `watcherIds`, `travelTimeTo`, `travelTimeFrom`

### AD-3 — `ticketId` FK validated in `CreateTask` via `ticketLookup: EntityLookup`

`CreateTask` gains a new optional `ticketLookup?: EntityLookup` injected last (after `projectLookup`). The lookup is only exercised when `data.ticketId` is non-null. This means:
- `POST /api/scheduling` (standard path) never passes `ticketId` → no lookup, zero overhead
- `CreateTaskFromTicket` passes `ticketId` → validated, ReferenceNotFoundError('ticket') → 404 `TICKET_NOT_FOUND`

Injecting as optional preserves full backward-compatibility for all existing callers of `CreateTask` (no constructor change needed for the ~10 call-sites in `app.ts`).

`ReferenceKind` in `domain/errors/scheduling.ts` gains `'ticket'` as a valid value.
`REFERENCE_TO_CODE` map in `scheduling.routes.ts` gains `ticket: 'TICKET_NOT_FOUND'`.

### AD-4 — `ticketSubject` in Task DTO via single Prisma include (zero N+1)

The shared `INCLUDE` constant in `PrismaSchedulingRepository.ts` gains:

```ts
ticket: { select: { id: true, subject: true } },
```

`toTask()` maps:
```ts
ticketId:      row.ticketId ?? null,
ticketSubject: row.ticket?.subject ?? null,
```

This feeds ALL read paths (listTasks, getTask, createTask response, updateTask response) — same mechanism as `customerName` from the `customer` join. Zero N+1.

### AD-5 — `ScheduledTask` entity += `ticketId` + `ticketSubject`

```ts
ticketId:      string | null;   // FK
ticketSubject: string | null;   // derived via JOIN — read-only
```

`CreateTaskInput` (port) already Omits derived fields via the interface definition — `ticketSubject` must be added to the Omit list. `ticketId` stays as input (it IS stored).

### AD-6 — In-memory repo parity

`NEW_FIELDS_DEFAULTS` in `InMemorySchedulingRepository.ts` gains:
```ts
ticketId:      null,
ticketSubject: null,
```

`createTask` in the in-memory repo persists `ticketId` from the input.

For route tests that assert `ticketSubject`, add a `ticketSubjects: Map<string, string>` side-store (same pattern as `projectNames` / `projects` maps already in the repo) with a `seedTicketSubject(ticketId, subject)` helper. `getTask` / `listTasks` derive `ticketSubject` from the map.

### AD-7 — Route mounting order

`POST /api/tickets/:id/tasks` is mounted on the **tickets router** (in `tickets.routes.ts`), BEFORE the existing `/:id` catch-all pattern. It is NOT on the scheduling router.

Why tickets router, not a separate router: it is semantically a ticket action — "from this ticket, create a task". The scheduling router lives at `/api/scheduling`. Cross-mounting is avoided.

The tickets router factory `createTicketsRouter` gains:
- `createTaskFromTicket: CreateTaskFromTicket` parameter
- `POST /:id/tasks` route (mounted before `GET /:id` to avoid shadowing — actually Express order: sub-path `/:id/tasks` before `/:id` is fine because the path length differs, but mount before `/:id/replies` for consistency)

`app.ts` wiring gains: instantiate `CreateTaskFromTicket` (needs `ticketRepo`, `createTask`, `stageRepo`), inject into `createTicketsRouter`.

### AD-8 — stageId default resolution — REUSE scheduling.routes pattern

`CreateTaskFromTicket` route handler reuses the exact same `stageId` resolution from `scheduling.routes.ts` (lines 285-298):
```ts
if (!stageId && stageRepo) {
  const defaultStage = await stageRepo.getDefaultWorkflowStageByLegacyStatus('pending');
  stageId = defaultStage?.id ?? '10000000-0000-4000-a000-000000000001';
}
```
The sentinel UUID is the same fallback. FE SHOULD send `stageId`; this is a safety net.

---

## 3. Overlapping files and integration strategy

The following ~8 files overlap with origin's task path. Each needs targeted additions only — no rewrites.

| File | Overlap type | Change needed |
|------|-------------|---------------|
| `prisma/schema.prisma` | `ScheduledTask` model, `Ticket` model | Add `ticketId` field + FK + index + `Ticket.tasks` back-relation |
| `src/domain/entities/scheduling.ts` | `ScheduledTask` interface | Add `ticketId: string \| null`, `ticketSubject: string \| null` |
| `src/domain/ports/SchedulingRepository.ts` | `CreateTaskInput` Omit list | Add `ticketSubject` to Omit list |
| `src/domain/errors/scheduling.ts` | `ReferenceKind` union type | Add `'ticket'` |
| `src/application/dto/scheduling.dto.ts` | `CreateTaskSchema` | No change needed — `stageId` is already optional, contract fields come from body; `ticketId` is NOT in this schema (ticket endpoint has its own schema) |
| `src/application/use-cases/CreateTask.ts` | Constructor + FK chain | Add optional `ticketLookup?: EntityLookup`; validate `data.ticketId` last in chain |
| `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts` | `INCLUDE` const + `toTask()` | Add `ticket` to INCLUDE; map `ticketId`/`ticketSubject` in `toTask()` |
| `src/infrastructure/adapters/in-memory/InMemorySchedulingRepository.ts` | `NEW_FIELDS_DEFAULTS` + `createTask` + derived-field logic | Add `ticketId`/`ticketSubject` defaults; persist ticketId; add ticketSubjects seed-map |
| `src/infrastructure/http/routes/tickets.routes.ts` | Router factory signature + new POST route | Add `createTaskFromTicket` param + `POST /:id/tasks` handler |
| `src/infrastructure/http/app.ts` | `createTicketsRouter` call + instantiation | Add `CreateTaskFromTicket` instantiation + inject into router call |

**New files**:
- `src/application/use-cases/CreateTaskFromTicket.ts`
- `src/application/dto/ticket-task.dto.ts` (Zod schema for `POST /:id/tasks` body)
- `src/__tests__/application/CreateTaskFromTicket.test.ts`
- `src/__tests__/infrastructure/tickets-tasks.route.test.ts` (route integration test)
- `prisma/migrations/20260602000000_ticket_task_fk/migration.sql`

---

## 4. `CreateTaskFromTicket` use case — full spec

```ts
// src/application/use-cases/CreateTaskFromTicket.ts

export interface CreateTaskFromTicketInput {
  ticketId:       string;       // from route path — NOT overridable
  contractId:     string;       // required body field
  priority:       string;       // required body field
  estimatedHours: number;       // required body field
  stageId?:       string | null;
  projectId?:     string | null;
  address?:       string | null;
  coordinates?:   { lat: number; lng: number } | null;
  category?:      string;
  notes?:         string | null;
  startDate?:     string | null;
  endDate?:       string | null;
  partnerId?:     string | null;
  reporterId?:    string | null;
  watcherIds?:    string[];
  travelTimeTo?:  number | null;
  travelTimeFrom?: number | null;
}

export class CreateTaskFromTicket {
  constructor(
    private readonly ticketRepo: TicketRepository,
    private readonly createTask: CreateTask,
  ) {}

  async execute(input: CreateTaskFromTicketInput): Promise<ScheduledTask> {
    const ticket = await this.ticketRepo.getById(input.ticketId);
    if (!ticket) throw new TicketNotFoundError(input.ticketId);

    return this.createTask.execute({
      title:          ticket.subject,
      description:    ticket.description,
      customerId:     ticket.customerId ?? null,
      contractId:     input.contractId,
      assigneeId:     ticket.assigneeId ?? null,
      ticketId:       input.ticketId,
      priority:       input.priority,
      estimatedHours: input.estimatedHours,
      stageId:        input.stageId!,  // resolved by route handler before call
      category:       input.category ?? 'other',
      projectId:      input.projectId ?? null,
      address:        input.address ?? null,
      coordinates:    input.coordinates ?? null,
      notes:          input.notes ?? null,
      startDate:      input.startDate ?? null,
      endDate:        input.endDate ?? null,
      partnerId:      input.partnerId ?? null,
      reporterId:     input.reporterId ?? null,
      watcherIds:     input.watcherIds ?? [],
      travelTimeTo:   input.travelTimeTo ?? null,
      travelTimeFrom: input.travelTimeFrom ?? null,
    });
  }
}
```

**TicketNotFoundError**: existing domain error (already exists in `domain/errors/ticket.ts` or similar — check; if not, add it there, not in scheduling.ts).

---

## 5. `ticket-task.dto.ts` — Zod schema for `POST /:id/tasks`

```ts
// src/application/dto/ticket-task.dto.ts
import { z } from 'zod';

export const CreateTaskFromTicketSchema = z.object({
  contractId:     z.string().min(1),          // required — user picks from client's contracts
  priority:       z.string().min(1),          // required — no default on ticket
  estimatedHours: z.number().nonnegative(),   // required

  // Optional overrides / extras
  stageId:        z.string().min(1).optional(),
  projectId:      z.string().min(1).nullable().optional(),
  address:        z.string().nullable().optional(),
  coordinates:    z.object({ lat: z.number(), lng: z.number() }).nullable().optional(),
  category:       z.string().min(1).optional(),
  notes:          z.string().nullable().optional(),
  startDate:      z.string().datetime({ offset: true }).nullable().optional(),
  endDate:        z.string().datetime({ offset: true }).nullable().optional(),
  partnerId:      z.string().min(1).nullable().optional(),
  reporterId:     z.string().min(1).nullable().optional(),
  watcherIds:     z.array(z.string().min(1)).optional(),
  travelTimeTo:   z.number().int().nonneg().nullable().optional(),
  travelTimeFrom: z.number().int().nonneg().nullable().optional(),
});
export type CreateTaskFromTicketInput = z.infer<typeof CreateTaskFromTicketSchema>;
```

---

## 6. Stacking on `contratos-naming-be` — field name contract

This branch is built AFTER `contratos-naming-be` applies its rename. Throughout all files:
- `serviceId` → `contractId` (in `ScheduledTask` entity, port, DTOs, repos, schema, routes)
- `SERVICE_NOT_FOUND` → `CONTRACT_NOT_FOUND` (in error codes)
- `ReferenceKind` already has `'contract'` (added by contratos-naming-be)

All design decisions above use `contractId`. The implementation MUST NOT reference `serviceId` anywhere in new code.

---

## 7. Non-goals (zero functionality removed)

- `POST /api/scheduling` (standard task create) — unchanged behavior
- All existing scheduling routes — unchanged
- All existing ticket routes — unchanged (new route is additive)
- `Ticket` model fields — unchanged (no `contractId` added to Ticket)
- Existing `CreateTask` constructor — stays backward-compatible (new param is optional)
