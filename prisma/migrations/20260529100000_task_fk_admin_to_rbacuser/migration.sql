-- =============================================================
-- Repoint task & ticket assignment FKs from legacy Admin to RbacUser.
--
-- After SDD #2, /auth/login validates only against RbacUser and the
-- JWT carries rbacUser.id. The scheduling/ticket tables still had
-- FKs to Admin, so creating tasks/tickets with the new user.id
-- failed at the DB layer with foreign-key violations.
--
-- This migration is destructive on stale references:
--   - ScheduledTask.reporterId / assigneeId → NULL if not in RbacUser
--   - Ticket.assigneeId                     → NULL if not in RbacUser
--   - TaskWatcher rows with a stale adminId → DELETED (same effect
--     CASCADE would have had if the Admin had been deleted)
--
-- Wrapped in BEGIN/COMMIT with a guard that aborts the whole
-- transaction if any orphan remains after cleanup, so the new FKs
-- can never be added against inconsistent data.
-- =============================================================

BEGIN;

-- 1. Drop existing FKs to Admin so we can clean orphans without conflicts
ALTER TABLE "ScheduledTask" DROP CONSTRAINT "ScheduledTask_reporterId_fkey";
ALTER TABLE "ScheduledTask" DROP CONSTRAINT "ScheduledTask_assigneeId_fkey";
ALTER TABLE "TaskWatcher"   DROP CONSTRAINT "TaskWatcher_adminId_fkey";
ALTER TABLE "Ticket"        DROP CONSTRAINT "Ticket_assigneeId_fkey";

-- 2. Nullify orphan reporter/assignee references (ids that don't exist in RbacUser).
--    Matches the prior ON DELETE SET NULL semantics.
UPDATE "ScheduledTask"
   SET "reporterId" = NULL
 WHERE "reporterId" IS NOT NULL
   AND "reporterId" NOT IN (SELECT "id" FROM "RbacUser");

UPDATE "ScheduledTask"
   SET "assigneeId" = NULL
 WHERE "assigneeId" IS NOT NULL
   AND "assigneeId" NOT IN (SELECT "id" FROM "RbacUser");

UPDATE "Ticket"
   SET "assigneeId" = NULL
 WHERE "assigneeId" IS NOT NULL
   AND "assigneeId" NOT IN (SELECT "id" FROM "RbacUser");

-- 3. Delete orphan TaskWatcher rows. The prior FK was ON DELETE CASCADE,
--    so removing the legacy Admin would have removed these watchers
--    anyway — this just brings the table into a consistent state.
DELETE FROM "TaskWatcher"
 WHERE "adminId" NOT IN (SELECT "id" FROM "RbacUser");

-- 4. Guard: hard-stop the migration if any orphan remains after cleanup.
--    Should be unreachable given the UPDATE/DELETE above, but if it
--    fires it means our assumptions are wrong and we'd rather abort
--    than create the new constraints against inconsistent data.
DO $$
DECLARE
  orphans INT;
BEGIN
  SELECT count(*) INTO orphans FROM "ScheduledTask"
    WHERE "reporterId" IS NOT NULL
      AND "reporterId" NOT IN (SELECT "id" FROM "RbacUser");
  IF orphans > 0 THEN
    RAISE EXCEPTION 'orphan ScheduledTask.reporterId remaining: %', orphans;
  END IF;

  SELECT count(*) INTO orphans FROM "ScheduledTask"
    WHERE "assigneeId" IS NOT NULL
      AND "assigneeId" NOT IN (SELECT "id" FROM "RbacUser");
  IF orphans > 0 THEN
    RAISE EXCEPTION 'orphan ScheduledTask.assigneeId remaining: %', orphans;
  END IF;

  SELECT count(*) INTO orphans FROM "TaskWatcher"
    WHERE "adminId" NOT IN (SELECT "id" FROM "RbacUser");
  IF orphans > 0 THEN
    RAISE EXCEPTION 'orphan TaskWatcher.adminId remaining: %', orphans;
  END IF;

  SELECT count(*) INTO orphans FROM "Ticket"
    WHERE "assigneeId" IS NOT NULL
      AND "assigneeId" NOT IN (SELECT "id" FROM "RbacUser");
  IF orphans > 0 THEN
    RAISE EXCEPTION 'orphan Ticket.assigneeId remaining: %', orphans;
  END IF;
END $$;

-- 5. Add the new FKs pointing to RbacUser. Same delete semantics as before.
ALTER TABLE "ScheduledTask"
  ADD CONSTRAINT "ScheduledTask_reporterId_fkey"
  FOREIGN KEY ("reporterId") REFERENCES "RbacUser"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ScheduledTask"
  ADD CONSTRAINT "ScheduledTask_assigneeId_fkey"
  FOREIGN KEY ("assigneeId") REFERENCES "RbacUser"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TaskWatcher"
  ADD CONSTRAINT "TaskWatcher_adminId_fkey"
  FOREIGN KEY ("adminId") REFERENCES "RbacUser"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Ticket"
  ADD CONSTRAINT "Ticket_assigneeId_fkey"
  FOREIGN KEY ("assigneeId") REFERENCES "RbacUser"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
