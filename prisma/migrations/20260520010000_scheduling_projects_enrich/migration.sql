-- Down (manual)
-- Run this to revert the migration if needed:
--
-- DROP TABLE IF EXISTS "ProjectPartner";
-- DROP INDEX IF EXISTS "Project_visible_idx";
-- DROP INDEX IF EXISTS "Project_projectLeadId_idx";
-- DROP INDEX IF EXISTS "Project_workflowId_idx";
-- DROP INDEX IF EXISTS "Project_typeId_idx";
-- DROP INDEX IF EXISTS "Project_categoryId_idx";
-- ALTER TABLE "Project" DROP CONSTRAINT IF EXISTS "Project_projectLeadId_fkey";
-- ALTER TABLE "Project" DROP CONSTRAINT IF EXISTS "Project_workflowId_fkey";
-- ALTER TABLE "Project" DROP CONSTRAINT IF EXISTS "Project_categoryId_fkey";
-- ALTER TABLE "Project" DROP CONSTRAINT IF EXISTS "Project_typeId_fkey";
-- ALTER TABLE "Project" DROP COLUMN IF EXISTS "visible";
-- ALTER TABLE "Project" DROP COLUMN IF EXISTS "projectLeadId";
-- ALTER TABLE "Project" DROP COLUMN IF EXISTS "workflowId";
-- ALTER TABLE "Project" DROP COLUMN IF EXISTS "categoryId";
-- ALTER TABLE "Project" DROP COLUMN IF EXISTS "typeId";

-- DDL ------------------------------------------------------------
ALTER TABLE "Project" ADD COLUMN "typeId"          TEXT;
ALTER TABLE "Project" ADD COLUMN "categoryId"      TEXT;
ALTER TABLE "Project" ADD COLUMN "workflowId"      TEXT;
ALTER TABLE "Project" ADD COLUMN "projectLeadId"   TEXT;
ALTER TABLE "Project" ADD COLUMN "visible"         BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "Project"
  ADD CONSTRAINT "Project_typeId_fkey"
    FOREIGN KEY ("typeId")        REFERENCES "ProjectType"("id")     ON DELETE SET NULL,
  ADD CONSTRAINT "Project_categoryId_fkey"
    FOREIGN KEY ("categoryId")    REFERENCES "ProjectCategory"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "Project_workflowId_fkey"
    FOREIGN KEY ("workflowId")    REFERENCES "Workflow"("id")        ON DELETE SET NULL,
  ADD CONSTRAINT "Project_projectLeadId_fkey"
    FOREIGN KEY ("projectLeadId") REFERENCES "Admin"("id")           ON DELETE SET NULL;

CREATE INDEX "Project_categoryId_idx"     ON "Project"("categoryId");
CREATE INDEX "Project_typeId_idx"         ON "Project"("typeId");
CREATE INDEX "Project_workflowId_idx"     ON "Project"("workflowId");
CREATE INDEX "Project_projectLeadId_idx"  ON "Project"("projectLeadId");
CREATE INDEX "Project_visible_idx"        ON "Project"("visible");

CREATE TABLE "ProjectPartner" (
  "projectId" TEXT NOT NULL,
  "partnerId" TEXT NOT NULL,
  CONSTRAINT "ProjectPartner_pkey" PRIMARY KEY ("projectId", "partnerId"),
  CONSTRAINT "ProjectPartner_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE,
  CONSTRAINT "ProjectPartner_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT
);
CREATE INDEX "ProjectPartner_partnerId_idx" ON "ProjectPartner"("partnerId");

-- Data backfill --------------------------------------------------
-- Idempotent: only updates rows that haven't been backfilled yet.
-- Uses DO $$ ... $$ pattern per change-1 lesson (NOT ON CONFLICT ON CONSTRAINT).
DO $$
DECLARE
  default_workflow_id TEXT;
BEGIN
  SELECT "id" INTO default_workflow_id
  FROM "Workflow"
  WHERE "name" = 'Default'
  LIMIT 1;

  IF default_workflow_id IS NOT NULL THEN
    UPDATE "Project"
    SET "workflowId" = default_workflow_id
    WHERE "workflowId" IS NULL;
  ELSE
    RAISE NOTICE 'Default workflow not found — projects retain workflowId = NULL. Re-run prisma:seed to restore.';
  END IF;
END $$;
