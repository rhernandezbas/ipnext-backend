-- Phase 2: Convert Ticket.status enum column to FK → TicketStatusCatalog.
-- Transactional, guarded backfill — if any ticket row cannot be mapped, the
-- entire migration aborts with a clear error and production is left untouched.

-- Step 1: add the new nullable FK column
ALTER TABLE "Ticket" ADD COLUMN "statusId" TEXT;

-- Step 2: backfill — map each ticket's current status string to the matching
-- TicketStatusCatalog row by name (names are identical: open/pending/closed).
UPDATE "Ticket" t
SET "statusId" = ts."id"
FROM "TicketStatusCatalog" ts
WHERE ts."name" = t."status"::TEXT;

-- Step 3: abort if any row was not matched (no TicketStatusCatalog entry for its name).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "Ticket" WHERE "statusId" IS NULL) THEN
    RAISE EXCEPTION 'Phase2 abort: % ticket(s) have no matching TicketStatusCatalog row',
      (SELECT count(*) FROM "Ticket" WHERE "statusId" IS NULL);
  END IF;
END $$;

-- Step 4: make statusId NOT NULL now that every row is mapped.
ALTER TABLE "Ticket" ALTER COLUMN "statusId" SET NOT NULL;

-- Step 5: add FK constraint (CASCADE on update so catalog renames propagate).
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_statusId_fkey"
  FOREIGN KEY ("statusId") REFERENCES "TicketStatusCatalog"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

-- Step 6: index on the FK column.
CREATE INDEX "Ticket_statusId_idx" ON "Ticket"("statusId");

-- Step 7: drop the old enum column (now replaced by the FK relation).
ALTER TABLE "Ticket" DROP COLUMN "status";

-- Step 8: drop the now-unused enum type.
DROP TYPE "TicketStatus";
