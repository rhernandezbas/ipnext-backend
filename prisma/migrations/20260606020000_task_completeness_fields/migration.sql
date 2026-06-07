-- #14: per-task closure-completeness flags + auto-complete flag seed + backfill.
-- Additive + idempotent → safe to push directly.

-- 1. Add the three flags (additive, default false).
ALTER TABLE "ScheduledTask" ADD COLUMN "closureCommentDone" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ScheduledTask" ADD COLUMN "closureAuditDone" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ScheduledTask" ADD COLUMN "closureHasDeviceInventory" BOOLEAN NOT NULL DEFAULT false;

-- 2. Seed the auto-complete feature flag (default OFF), idempotent.
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('task-autocomplete', false, NOW())
ON CONFLICT ("key") DO NOTHING;

-- 3. Backfill the flags from the current state (idempotent — re-running gives the same result).
UPDATE "ScheduledTask" t SET "closureAuditDone" = true
 WHERE EXISTS (SELECT 1 FROM "TaskInstallationAudit" a WHERE a."taskId" = t.id);

UPDATE "ScheduledTask" t SET "closureHasDeviceInventory" = true
 WHERE EXISTS (SELECT 1 FROM "TaskInventorySuggestion" s
               WHERE s."taskId" = t.id AND s."kind" = 'DEVICE' AND s."status" <> 'discarded');

UPDATE "ScheduledTask" t SET "closureCommentDone" = true
 WHERE EXISTS (SELECT 1 FROM "IClassServiceOrder" o
               WHERE o."scheduledTaskId" = t.id AND o."commentPosted" = true);
