-- AlterTable
ALTER TABLE "ScheduledTask" ADD COLUMN     "grOrdenId" TEXT;

-- CreateTable
CREATE TABLE "GestionRealIngestConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "intervalMs" INTEGER NOT NULL DEFAULT 180000,
    "windowMonths" INTEGER NOT NULL DEFAULT 12,
    "fiberProjectId" TEXT,
    "wirelessProjectId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GestionRealIngestConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GestionRealIngestConfig_fiberProjectId_idx" ON "GestionRealIngestConfig"("fiberProjectId");

-- CreateIndex
CREATE INDEX "GestionRealIngestConfig_wirelessProjectId_idx" ON "GestionRealIngestConfig"("wirelessProjectId");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledTask_grOrdenId_key" ON "ScheduledTask"("grOrdenId");

-- AddForeignKey
ALTER TABLE "GestionRealIngestConfig" ADD CONSTRAINT "GestionRealIngestConfig_fiberProjectId_fkey" FOREIGN KEY ("fiberProjectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GestionRealIngestConfig" ADD CONSTRAINT "GestionRealIngestConfig_wirelessProjectId_fkey" FOREIGN KEY ("wirelessProjectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
