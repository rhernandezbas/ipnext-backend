-- #11: Add monotonic sequenceNumber to Ticket (like ScheduledTask) so deleted IDs
-- are never reused. New tickets always get a higher number than any inserted before.

-- 1. Add nullable column to allow backfill
ALTER TABLE "Ticket" ADD COLUMN "sequenceNumber" INTEGER;

-- 2. Backfill existing rows in createdAt order so older tickets get lower numbers
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY "createdAt", id) AS rn
  FROM "Ticket"
)
UPDATE "Ticket"
SET "sequenceNumber" = numbered.rn
FROM numbered
WHERE "Ticket".id = numbered.id;

-- 3. Create the sequence and bind ownership for cascade cleanup
CREATE SEQUENCE "Ticket_sequenceNumber_seq" OWNED BY "Ticket"."sequenceNumber";

-- 4. Position the sequence after the highest backfilled value
SELECT setval(
  '"Ticket_sequenceNumber_seq"',
  COALESCE((SELECT MAX("sequenceNumber") FROM "Ticket"), 0)
);

-- 5. Make the column NOT NULL with the sequence as default
ALTER TABLE "Ticket"
  ALTER COLUMN "sequenceNumber" SET DEFAULT nextval('"Ticket_sequenceNumber_seq"'),
  ALTER COLUMN "sequenceNumber" SET NOT NULL;

-- 6. Enforce uniqueness at the database level
CREATE UNIQUE INDEX "Ticket_sequenceNumber_key" ON "Ticket"("sequenceNumber");
