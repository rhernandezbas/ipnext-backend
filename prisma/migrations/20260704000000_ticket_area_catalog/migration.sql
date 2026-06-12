-- #49 — Ticket Area Catalog: CREATE TABLE + ALTER TABLE Ticket ADD areaId + FK + indexes
-- Generated via: prisma migrate diff --from-schema /tmp/before.prisma --to-schema prisma/schema.prisma --script
-- Additive only. No BEGIN/COMMIT (Prisma wraps each migration in its own transaction).

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "areaId" TEXT;

-- CreateTable
CREATE TABLE "TicketAreaCatalog" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketAreaCatalog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TicketAreaCatalog_name_key" ON "TicketAreaCatalog"("name");

-- CreateIndex
CREATE INDEX "Ticket_areaId_idx" ON "Ticket"("areaId");

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "TicketAreaCatalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed default areas (idempotent — ON CONFLICT ("name") DO NOTHING)
INSERT INTO "TicketAreaCatalog" ("id", "name", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'Soporte',         NOW(), NOW()),
  (gen_random_uuid(), 'Administración',  NOW(), NOW()),
  (gen_random_uuid(), 'Facturación',     NOW(), NOW())
ON CONFLICT ("name") DO NOTHING;
