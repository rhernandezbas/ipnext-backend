-- Add address column to UispSite
-- Idempotent: IF NOT EXISTS guard.
-- No BEGIN/COMMIT wrappers — per migration incident rule.

ALTER TABLE "UispSite" ADD COLUMN IF NOT EXISTS "address" TEXT;
