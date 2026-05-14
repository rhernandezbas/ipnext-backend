-- Add monotonic sequenceNumber to ScheduledTask so deleted IDs are never reused.
-- New tasks always get a higher number than any task ever inserted, even if older tasks were deleted.

-- 1. Add nullable column to allow backfill
ALTER TABLE "ScheduledTask" ADD COLUMN "sequenceNumber" INTEGER;

-- 2. Backfill existing rows in createdAt order so older tasks get lower numbers
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY "createdAt", id) AS rn
  FROM "ScheduledTask"
)
UPDATE "ScheduledTask"
SET "sequenceNumber" = numbered.rn
FROM numbered
WHERE "ScheduledTask".id = numbered.id;

-- 3. Create the sequence and bind ownership for cascade cleanup
CREATE SEQUENCE "ScheduledTask_sequenceNumber_seq" OWNED BY "ScheduledTask"."sequenceNumber";

-- 4. Position the sequence after the highest backfilled value
SELECT setval(
  '"ScheduledTask_sequenceNumber_seq"',
  COALESCE((SELECT MAX("sequenceNumber") FROM "ScheduledTask"), 0)
);

-- 5. Make the column NOT NULL with the sequence as default
ALTER TABLE "ScheduledTask"
  ALTER COLUMN "sequenceNumber" SET DEFAULT nextval('"ScheduledTask_sequenceNumber_seq"'),
  ALTER COLUMN "sequenceNumber" SET NOT NULL;

-- 6. Enforce uniqueness so the contract is database-level
CREATE UNIQUE INDEX "ScheduledTask_sequenceNumber_key" ON "ScheduledTask"("sequenceNumber");
