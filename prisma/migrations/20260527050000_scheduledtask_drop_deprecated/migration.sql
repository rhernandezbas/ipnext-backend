-- Phase 4: contract. Drop deprecated ScheduledTask columns + stale indexes.
-- DESTRUCTIVE. A full DB snapshot was taken before applying in PROD.
-- Down (manual, schema only — data NOT recoverable):
--   ALTER TABLE "ScheduledTask" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pending';
--   ALTER TABLE "ScheduledTask" ADD COLUMN "scheduledDate" TEXT;
--   ALTER TABLE "ScheduledTask" ADD COLUMN "scheduledTime" TEXT;
--   ALTER TABLE "ScheduledTask" ADD COLUMN "clientId" TEXT;
--   ALTER TABLE "ScheduledTask" ADD COLUMN "clientName" TEXT;
--   ALTER TABLE "ScheduledTask" ADD COLUMN "assignedTo" TEXT;
--   ALTER TABLE "ScheduledTask" ADD COLUMN "assignedToId" TEXT;
--   CREATE INDEX "ScheduledTask_status_idx" ON "ScheduledTask"("status");
--   CREATE INDEX "ScheduledTask_scheduledDate_idx" ON "ScheduledTask"("scheduledDate");

DROP INDEX IF EXISTS "ScheduledTask_status_idx";
DROP INDEX IF EXISTS "ScheduledTask_scheduledDate_idx";

ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "status";
ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "scheduledDate";
ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "scheduledTime";
ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "clientId";
ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "clientName";
ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "assignedTo";
ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "assignedToId";
