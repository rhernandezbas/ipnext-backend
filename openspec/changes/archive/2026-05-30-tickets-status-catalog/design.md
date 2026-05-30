# Design: tickets-status-catalog

## Architecture Decisions

### AD-1: Mirror TaskPriority pattern exactly
The TaskPriority catalog is the established reference pattern in this codebase. TicketStatus catalog mirrors it 1:1: same entity shape (id, name, color, weight), same port interface, same in-memory/Prisma adapter structure, same use-case names (verb+noun), same route shape.

### AD-2: Phase 1 = catalog CRUD only; Phase 2 = FK migration
Converting `Ticket.status` from a Prisma enum column to a FK column is potentially **DESTRUCTIVE** (see Migration Strategy below). Phase 1 delivers the catalog as a standalone table coexisting with the existing `enum TicketStatus`. The existing ticket routes/use-cases/tests are NOT touched in Phase 1.

Phase 2 (FK migration) must be executed by the developer with a live DB after reviewing the generated migration SQL.

### AD-3: Delete guard by name
Like TaskPriority (which guards by `ScheduledTask.priority` name), the delete guard queries `Ticket.status` (enum string column) for tickets using that status name. This works in Phase 1 without a FK. When Phase 2 converts to FK, the guard becomes a count on the FK column instead.

### AD-4: Route prefix
`/api/tickets/statuses` — keeps the resource under the tickets domain. Mounted BEFORE the existing `createTicketsRouter` to avoid the `/:id` catch-all swallowing `/statuses`.

### AD-5: Naming — no collision with existing TicketStatus type
The existing `src/domain/entities/ticket.ts` exports `type TicketStatus = 'open' | 'pending' | 'closed'`. The new entity is `TicketStatusCatalog` in its file to avoid collision. The Prisma model is `TicketStatus` (table name). The port is `TicketStatusRepository`.

---

## Migration Strategy

### WARNING: This migration is POTENTIALLY DESTRUCTIVE

Converting `Ticket.status TicketStatus @default(open)` (enum column) to `Ticket.statusId String FK → TicketStatus.id` requires a multi-step migration. If `prisma migrate dev` generates a single migration that drops the enum column before backfilling, ALL existing Ticket rows lose their status data.

### Correct Multi-Step Approach

Phase 2 migration must follow this sequence. Do NOT let `prisma migrate dev` generate a single all-in-one migration.

**Step 1** — Add `TicketStatus` table + seed canonical values:
```sql
CREATE TABLE "TicketStatus" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL UNIQUE,
  "color" TEXT NOT NULL,
  "weight" INTEGER NOT NULL,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL
);
INSERT INTO "TicketStatus" ("id","name","color","weight","createdAt","updatedAt") VALUES
  (gen_random_uuid(), 'open',    '#22c55e', 1, NOW(), NOW()),
  (gen_random_uuid(), 'pending', '#f59e0b', 2, NOW(), NOW()),
  (gen_random_uuid(), 'closed',  '#94a3b8', 3, NOW(), NOW());
```

**Step 2** — Add nullable FK column `statusId` to `Ticket`:
```sql
ALTER TABLE "Ticket" ADD COLUMN "statusId" TEXT REFERENCES "TicketStatus"("id") ON DELETE SET NULL;
```

**Step 3** — Backfill `statusId` from the old enum column:
```sql
UPDATE "Ticket" t
SET "statusId" = ts.id
FROM "TicketStatus" ts
WHERE ts.name = t.status::TEXT;
```

**Step 4** — Make `statusId` required and drop the old enum column + enum type:
```sql
ALTER TABLE "Ticket" ALTER COLUMN "statusId" SET NOT NULL;
ALTER TABLE "Ticket" DROP COLUMN "status";
DROP TYPE "TicketStatus";
```

### Prisma Schema for Phase 2

After migration, `schema.prisma` Ticket model becomes:
```prisma
model Ticket {
  id          String              @id @default(uuid())
  subject     String
  description String

  statusId    String
  status      TicketStatusCatalog @relation(fields: [statusId], references: [id])
  priority    TicketPriority      @default(medium)
  ...
}
```
And the `enum TicketStatus` is removed.

### User Instructions

1. Run Phase 1 of this change (catalog CRUD) — this adds `model TicketStatus` to schema.prisma.
2. Run `npm run prisma:migrate` — Prisma will generate a migration for ONLY the new table. This is safe.
3. Run `npm run prisma:seed` — seeds open/pending/closed.
4. When ready to migrate the FK (Phase 2):
   a. Modify schema.prisma to add `statusId`/`status` relation and remove the old enum.
   b. Run `npm run prisma:migrate` — **REVIEW the generated SQL before confirming**.
   c. If the generated migration is destructive (drops the column before backfill), **DO NOT apply it**. Instead, split into 3 separate `prisma migrate dev` calls using the steps above.
   d. Verify row count in Ticket table before and after.

### Seed Strategy

`prisma/seed.ts` already seeds other catalogs via `createMany({ skipDuplicates: true })`. Same pattern used for TicketStatus canonical values.
