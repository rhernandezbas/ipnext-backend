-- scheduling-foundation-stage-model
-- Adds Workflow, Stage, ProjectCategory, ProjectType models.
-- Migrates ScheduledTask.status (String) to stageId (FK Stage).
-- Legacy status column is RETAINED for one release as a backward-compat read-only field.

-- 1. StageCategory enum
CREATE TYPE "StageCategory" AS ENUM ('nuevo', 'enProgreso', 'hecho');

-- 2. Tables
CREATE TABLE "Workflow" (
  "id"          TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Workflow_pkey" PRIMARY KEY ("id")
);
-- Case-insensitive unique index (not @unique in Prisma because Prisma doesn't support CI uniqueness directly)
CREATE UNIQUE INDEX "Workflow_name_lower_key" ON "Workflow" (LOWER("name"));

CREATE TABLE "Stage" (
  "id"         TEXT NOT NULL,
  "workflowId" TEXT NOT NULL,
  "name"       TEXT NOT NULL,
  "category"   "StageCategory" NOT NULL,
  "order"      INTEGER NOT NULL,

  CONSTRAINT "Stage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Stage_workflowId_name_lower_key" ON "Stage" ("workflowId", LOWER("name"));
CREATE INDEX "Stage_workflowId_order_idx" ON "Stage" ("workflowId", "order");
ALTER TABLE "Stage" ADD CONSTRAINT "Stage_workflowId_fkey"
  FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProjectCategory" (
  "id"          TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,

  CONSTRAINT "ProjectCategory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProjectCategory_name_lower_key" ON "ProjectCategory" (LOWER("name"));

CREATE TABLE "ProjectType" (
  "id"          TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,

  CONSTRAINT "ProjectType_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProjectType_name_lower_key" ON "ProjectType" (LOWER("name"));

-- 3. Bootstrap Default workflow + 11 stages (idempotent — ON CONFLICT DO NOTHING)
WITH new_wf AS (
  INSERT INTO "Workflow" ("id", "name", "description", "updatedAt")
  VALUES (
    gen_random_uuid()::text,
    'Default',
    'Default workflow seeded by scheduling-foundation-stage-model',
    NOW()
  )
  ON CONFLICT (LOWER("name")) DO NOTHING
  RETURNING "id"
),
wf AS (
  SELECT "id" FROM new_wf
  UNION ALL
  SELECT "id" FROM "Workflow" WHERE LOWER("name") = 'default' LIMIT 1
)
INSERT INTO "Stage" ("id", "workflowId", "name", "category", "order")
SELECT gen_random_uuid()::text, wf.id, s.name, s.category::"StageCategory", s.ord
FROM wf, (VALUES
  ('Nuevo',                'nuevo',      0),
  ('Confirmado',           'nuevo',      1),
  ('Pospuesta',            'nuevo',      2),
  ('No Factible',          'nuevo',      3),
  ('Enviar a IClass',      'nuevo',      4),
  ('Registrado en IClass', 'nuevo',      5),
  ('Notificado',           'nuevo',      6),
  ('En progreso',          'enProgreso', 7),
  ('Instalado',            'hecho',      8),
  ('Hecho',                'hecho',      9),
  ('Anulado-Cancelado',    'hecho',      10)
) AS s(name, category, ord)
ON CONFLICT ON CONSTRAINT "Stage_workflowId_name_lower_key" DO NOTHING;

-- 4. Add stageId column to ScheduledTask (nullable first for backfill)
ALTER TABLE "ScheduledTask" ADD COLUMN "stageId" TEXT;

-- 5. Backfill: map existing status values to the matching Default workflow Stage
UPDATE "ScheduledTask" t
SET "stageId" = s."id"
FROM "Workflow" w
JOIN "Stage" s ON s."workflowId" = w."id"
WHERE LOWER(w."name") = 'default'
  AND (
       (t."status" = 'pending'      AND s."name" = 'Nuevo')
    OR (t."status" = 'in_progress'  AND s."name" = 'En progreso')
    OR (t."status" = 'completed'    AND s."name" = 'Hecho')
    OR (t."status" = 'cancelled'    AND s."name" = 'Anulado-Cancelado')
  );

-- Safety net: any row still NULL (unknown status) → map to Default "Nuevo"
UPDATE "ScheduledTask" t
SET "stageId" = (
  SELECT s."id"
  FROM "Stage" s
  JOIN "Workflow" w ON w."id" = s."workflowId"
  WHERE LOWER(w."name") = 'default' AND s."name" = 'Nuevo'
  LIMIT 1
)
WHERE t."stageId" IS NULL;

-- 6. Make stageId NOT NULL now that every row is backfilled
ALTER TABLE "ScheduledTask" ALTER COLUMN "stageId" SET NOT NULL;

-- FK + index for stageId
ALTER TABLE "ScheduledTask"
  ADD CONSTRAINT "ScheduledTask_stageId_fkey"
  FOREIGN KEY ("stageId") REFERENCES "Stage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "ScheduledTask_stageId_idx" ON "ScheduledTask" ("stageId");
