-- Down (manual)
-- DROP TABLE IF EXISTS "TaskCategory";

-- CreateTable
CREATE TABLE "TaskCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TaskCategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaskCategory_name_key" ON "TaskCategory"("name");

-- Seed the categories that used to be hardcoded as an enum. Fixed UUIDs keep the
-- seed deterministic and avoid relying on a DB-side uuid function.
INSERT INTO "TaskCategory" ("id", "name", "description", "createdAt", "updatedAt") VALUES
  ('a0000001-0000-4000-8000-000000000001', 'Instalación',   NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('a0000002-0000-4000-8000-000000000002', 'Reparación',    NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('a0000003-0000-4000-8000-000000000003', 'Mantenimiento', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('a0000004-0000-4000-8000-000000000004', 'Inspección',    NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('a0000005-0000-4000-8000-000000000005', 'Otro',          NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;
