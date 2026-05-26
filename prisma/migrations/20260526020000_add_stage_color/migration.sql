-- Down (manual)
-- ALTER TABLE "Stage" DROP COLUMN IF EXISTS "color";

-- Add an editable colour to stages.
ALTER TABLE "Stage" ADD COLUMN "color" TEXT;

-- Seed sensible defaults by category so existing stages start with a colour.
UPDATE "Stage" SET "color" = '#3b82f6' WHERE "category" = 'nuevo'      AND "color" IS NULL;
UPDATE "Stage" SET "color" = '#f59e0b' WHERE "category" = 'enProgreso' AND "color" IS NULL;
UPDATE "Stage" SET "color" = '#22c55e' WHERE "category" = 'hecho'      AND "color" IS NULL;
