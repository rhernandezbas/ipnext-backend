-- Migration: networksite_uisp_link
-- Adds optional uispSiteId column to NetworkSite.
-- No FK constraint to UispSite — the mirror re-upserts by uispId TEXT;
-- validation is enforced at the application layer (not DB).
-- Idempotent via IF NOT EXISTS.

ALTER TABLE "NetworkSite"
  ADD COLUMN IF NOT EXISTS "uispSiteId" TEXT;

CREATE INDEX IF NOT EXISTS "NetworkSite_uispSiteId_idx"
  ON "NetworkSite" ("uispSiteId");
