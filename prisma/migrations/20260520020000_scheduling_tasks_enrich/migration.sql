-- scheduling-tasks-enrich migration
-- Adds datetime envelope (startDate/endDate), FK relations (customer/service/partner/reporter/assignee),
-- travel time columns, and TaskWatcher pivot table to ScheduledTask.
-- Legacy columns (scheduledDate, scheduledTime, clientId, clientName, assignedTo, assignedToId, status)
-- are retained as deprecated read-only for one release.
--
-- Down SQL (manual rollback):
-- DROP TABLE IF EXISTS "TaskWatcher";
-- DROP INDEX IF EXISTS "ScheduledTask_startDate_idx";
-- DROP INDEX IF EXISTS "ScheduledTask_endDate_idx";
-- DROP INDEX IF EXISTS "ScheduledTask_customerId_idx";
-- DROP INDEX IF EXISTS "ScheduledTask_serviceId_idx";
-- DROP INDEX IF EXISTS "ScheduledTask_partnerId_idx";
-- DROP INDEX IF EXISTS "ScheduledTask_assigneeId_idx";
-- DROP INDEX IF EXISTS "ScheduledTask_reporterId_idx";
-- ALTER TABLE "ScheduledTask" DROP CONSTRAINT IF EXISTS "ScheduledTask_assigneeId_fkey";
-- ALTER TABLE "ScheduledTask" DROP CONSTRAINT IF EXISTS "ScheduledTask_reporterId_fkey";
-- ALTER TABLE "ScheduledTask" DROP CONSTRAINT IF EXISTS "ScheduledTask_partnerId_fkey";
-- ALTER TABLE "ScheduledTask" DROP CONSTRAINT IF EXISTS "ScheduledTask_serviceId_fkey";
-- ALTER TABLE "ScheduledTask" DROP CONSTRAINT IF EXISTS "ScheduledTask_customerId_fkey";
-- ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "travelTimeFrom";
-- ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "travelTimeTo";
-- ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "assigneeId";
-- ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "reporterId";
-- ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "partnerId";
-- ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "serviceId";
-- ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "customerId";
-- ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "endDate";
-- ALTER TABLE "ScheduledTask" DROP COLUMN IF EXISTS "startDate";

-- DDL ------------------------------------------------------------
ALTER TABLE "ScheduledTask" ADD COLUMN "startDate"      TIMESTAMP(3);
ALTER TABLE "ScheduledTask" ADD COLUMN "endDate"        TIMESTAMP(3);
ALTER TABLE "ScheduledTask" ADD COLUMN "customerId"     TEXT;
ALTER TABLE "ScheduledTask" ADD COLUMN "serviceId"      TEXT;
ALTER TABLE "ScheduledTask" ADD COLUMN "partnerId"      TEXT;
ALTER TABLE "ScheduledTask" ADD COLUMN "reporterId"     TEXT;
ALTER TABLE "ScheduledTask" ADD COLUMN "assigneeId"     TEXT;
ALTER TABLE "ScheduledTask" ADD COLUMN "travelTimeTo"   INTEGER;
ALTER TABLE "ScheduledTask" ADD COLUMN "travelTimeFrom" INTEGER;

ALTER TABLE "ScheduledTask"
  ADD CONSTRAINT "ScheduledTask_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Client"("id")  ON DELETE SET NULL,
  ADD CONSTRAINT "ScheduledTask_serviceId_fkey"
    FOREIGN KEY ("serviceId")  REFERENCES "Service"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "ScheduledTask_partnerId_fkey"
    FOREIGN KEY ("partnerId")  REFERENCES "Partner"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "ScheduledTask_reporterId_fkey"
    FOREIGN KEY ("reporterId") REFERENCES "Admin"("id")   ON DELETE SET NULL,
  ADD CONSTRAINT "ScheduledTask_assigneeId_fkey"
    FOREIGN KEY ("assigneeId") REFERENCES "Admin"("id")   ON DELETE SET NULL;

CREATE INDEX "ScheduledTask_startDate_idx"   ON "ScheduledTask"("startDate");
CREATE INDEX "ScheduledTask_endDate_idx"     ON "ScheduledTask"("endDate");
CREATE INDEX "ScheduledTask_customerId_idx"  ON "ScheduledTask"("customerId");
CREATE INDEX "ScheduledTask_serviceId_idx"   ON "ScheduledTask"("serviceId");
CREATE INDEX "ScheduledTask_partnerId_idx"   ON "ScheduledTask"("partnerId");
CREATE INDEX "ScheduledTask_assigneeId_idx"  ON "ScheduledTask"("assigneeId");
CREATE INDEX "ScheduledTask_reporterId_idx"  ON "ScheduledTask"("reporterId");

CREATE TABLE "TaskWatcher" (
  "taskId"  TEXT NOT NULL,
  "adminId" TEXT NOT NULL,
  CONSTRAINT "TaskWatcher_pkey" PRIMARY KEY ("taskId", "adminId"),
  CONSTRAINT "TaskWatcher_taskId_fkey"
    FOREIGN KEY ("taskId")  REFERENCES "ScheduledTask"("id") ON DELETE CASCADE,
  CONSTRAINT "TaskWatcher_adminId_fkey"
    FOREIGN KEY ("adminId") REFERENCES "Admin"("id")         ON DELETE CASCADE
);
CREATE INDEX "TaskWatcher_adminId_idx" ON "TaskWatcher"("adminId");

-- Data backfill --------------------------------------------------
-- Idempotent: only updates rows where startDate is still NULL.
-- Uses DO $$ ... $$ pattern per change-1 lesson (NEVER ON CONFLICT ON CONSTRAINT).
-- Per-row EXCEPTION block tolerates unparseable legacy strings; emits NOTICE for ops visibility.
DO $$
DECLARE
  rec RECORD;
  candidate_text TEXT;
  parsed_start TIMESTAMP;
BEGIN
  FOR rec IN
    SELECT "id", "scheduledDate", "scheduledTime", "estimatedHours"
    FROM "ScheduledTask"
    WHERE "startDate" IS NULL
      AND "scheduledDate" IS NOT NULL
  LOOP
    candidate_text := rec."scheduledDate" || 'T' || COALESCE(rec."scheduledTime", '00:00') || ':00';
    BEGIN
      parsed_start := candidate_text::timestamp;
      UPDATE "ScheduledTask"
      SET "startDate" = parsed_start,
          "endDate"   = parsed_start + (COALESCE(rec."estimatedHours", 1) * INTERVAL '1 hour')
      WHERE "id" = rec."id";
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'scheduling-tasks-enrich: could not parse startDate for task % (input: %)', rec."id", candidate_text;
    END;
  END LOOP;
END $$;
