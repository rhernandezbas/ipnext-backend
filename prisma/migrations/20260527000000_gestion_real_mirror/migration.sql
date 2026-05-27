-- Down (manual)
-- ALTER TABLE "Client" DROP COLUMN IF EXISTS "grClienteId";
-- ALTER TABLE "Service" DROP COLUMN IF EXISTS "grContratoId";
-- DROP TABLE IF EXISTS "SyncState";

-- Gestión Real read-only mirror: external id columns + sync watermark store.

ALTER TABLE "Client" ADD COLUMN "grClienteId" TEXT;
CREATE UNIQUE INDEX "Client_grClienteId_key" ON "Client"("grClienteId");

ALTER TABLE "Service" ADD COLUMN "grContratoId" TEXT;
CREATE UNIQUE INDEX "Service_grContratoId_key" ON "Service"("grContratoId");

CREATE TABLE "SyncState" (
    "entity" TEXT NOT NULL,
    "cursor" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "lastResult" TEXT,
    "itemsSynced" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("entity")
);
