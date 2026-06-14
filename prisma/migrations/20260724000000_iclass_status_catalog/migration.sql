-- CreateTable: catálogo de estados de IClass (auto-discovery + config editable).
-- statusCode es el id opaco de IClass (status.id); displayLabel/color/tracked son editables por el operador.
CREATE TABLE "IClassStatusCatalog" (
    "id" TEXT NOT NULL,
    "statusCode" TEXT NOT NULL,
    "iclassLabel" TEXT NOT NULL,
    "displayLabel" TEXT,
    "color" TEXT,
    "tracked" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IClassStatusCatalog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IClassStatusCatalog_statusCode_key" ON "IClassStatusCatalog"("statusCode");
CREATE INDEX "IClassStatusCatalog_tracked_idx" ON "IClassStatusCatalog"("tracked");

-- AlterTable: estado actual de la OS en la tarea (solo el code; label/color por JOIN al catálogo).
ALTER TABLE "ScheduledTask" ADD COLUMN IF NOT EXISTS "iclassStatusCode" TEXT;
ALTER TABLE "ScheduledTask" ADD COLUMN IF NOT EXISTS "iclassStatusUpdatedAt" TIMESTAMP(3);
