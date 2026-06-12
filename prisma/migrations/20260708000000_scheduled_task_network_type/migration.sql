-- #66 — Add networkType (red|fibra) and networkSiteName (fibra free-text node name) to ScheduledTask.
-- networkType: optional discriminator; NULL / 'red' = legacy RED behaviour (networkSiteId FK).
--              'fibra' = free-text node name (networkSiteId must be NULL, networkSiteName stored).
-- networkSiteName: stored column for fibra; for red tasks it is JOIN-derived (networkSite.name).
--
-- Idempotent backfill: existing network tasks get networkType='red'.
-- NO BEGIN/COMMIT wrapper per project convention.

-- IF NOT EXISTS so the migration is idempotent / re-runnable (pattern #65).
ALTER TABLE "ScheduledTask" ADD COLUMN IF NOT EXISTS "networkType" TEXT;
ALTER TABLE "ScheduledTask" ADD COLUMN IF NOT EXISTS "networkSiteName" TEXT;

UPDATE "ScheduledTask" SET "networkType" = 'red' WHERE "kind" = 'network' AND "networkType" IS NULL;
