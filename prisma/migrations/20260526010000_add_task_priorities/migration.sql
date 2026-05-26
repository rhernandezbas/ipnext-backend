-- Down (manual)
-- DROP TABLE IF EXISTS "TaskPriority";

-- CreateTable
CREATE TABLE "TaskPriority" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "weight" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TaskPriority_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaskPriority_name_key" ON "TaskPriority"("name");

-- Seed the priorities that used to be a hardcoded enum, with colour + weight.
INSERT INTO "TaskPriority" ("id", "name", "color", "weight", "createdAt", "updatedAt") VALUES
  ('b0000001-0000-4000-8000-000000000001', 'Baja',    '#94a3b8', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('b0000002-0000-4000-8000-000000000002', 'Normal',  '#3b82f6', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('b0000003-0000-4000-8000-000000000003', 'Alta',    '#f59e0b', 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('b0000004-0000-4000-8000-000000000004', 'Urgente', '#ef4444', 4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;

-- Migrate existing tasks from the legacy enum codes to the catalog names.
UPDATE "ScheduledTask" SET "priority" = 'Baja'    WHERE "priority" = 'low';
UPDATE "ScheduledTask" SET "priority" = 'Normal'  WHERE "priority" = 'normal';
UPDATE "ScheduledTask" SET "priority" = 'Alta'    WHERE "priority" = 'high';
UPDATE "ScheduledTask" SET "priority" = 'Urgente' WHERE "priority" = 'urgent';
