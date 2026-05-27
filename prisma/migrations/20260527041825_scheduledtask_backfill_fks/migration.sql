-- Phase 1: complete the expand. Backfill customerId/assigneeId from legacy
-- columns. Forward-only, idempotent (WHERE new FK IS NULL). No DROP here.

-- customerId <- clientId (only if the referenced Client still exists)
UPDATE "ScheduledTask" t
SET "customerId" = t."clientId"
WHERE t."customerId" IS NULL
  AND t."clientId" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "Client" c WHERE c."id" = t."clientId");

-- assigneeId <- assignedToId (only if the referenced Admin still exists)
UPDATE "ScheduledTask" t
SET "assigneeId" = t."assignedToId"
WHERE t."assigneeId" IS NULL
  AND t."assignedToId" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "Admin" a WHERE a."id" = t."assignedToId");

-- assigneeId <- assignedTo (free text, best-effort name match)
UPDATE "ScheduledTask" t
SET "assigneeId" = a."id"
FROM "Admin" a
WHERE t."assigneeId" IS NULL
  AND t."assignedTo" IS NOT NULL
  AND LOWER(TRIM(a."name")) = LOWER(TRIM(t."assignedTo"));

-- Audit: report rows that still have legacy data but no new FK (Phase 4 gate)
DO $$
DECLARE orphan_clients INT; orphan_assignees INT;
BEGIN
  SELECT COUNT(*) INTO orphan_clients
  FROM "ScheduledTask"
  WHERE "customerId" IS NULL AND "clientId" IS NOT NULL;

  SELECT COUNT(*) INTO orphan_assignees
  FROM "ScheduledTask"
  WHERE "assigneeId" IS NULL AND ("assignedToId" IS NOT NULL OR "assignedTo" IS NOT NULL);

  RAISE NOTICE 'scheduledtask-backfill: % rows with clientId but no customerId; % rows with legacy assignee but no assigneeId',
    orphan_clients, orphan_assignees;
END $$;
