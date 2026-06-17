-- Migration: 20260731000000_pppoe_enforcement_model
-- Fase C (enforcement) — campo `enforcedState` en PppoeService (estado del corte, separado
-- del profile comercial) + tabla `ServiceCutBatch` (estado del job de corte masivo).
-- 100% ADITIVO (ADD COLUMN con default + CREATE TABLE). Seguro para prod.
-- Sin BEGIN/COMMIT explícito (Prisma envuelve cada migración en su transacción).

-- AlterTable
ALTER TABLE "PppoeService" ADD COLUMN     "enforcedState" TEXT NOT NULL DEFAULT 'active';

-- CreateTable
CREATE TABLE "ServiceCutBatch" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "total" INTEGER NOT NULL DEFAULT 0,
    "doneCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ServiceCutBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServiceCutBatch_status_idx" ON "ServiceCutBatch"("status");
