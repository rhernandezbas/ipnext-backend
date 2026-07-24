-- bulk-task-stage-transition (B1.1, TTC-1) — singleton config del estado resultante
-- global del bulk WhatsApp (dominio "Tarea"). ADITIVO: nueva tabla + FK SetNull, cero
-- cambio en tablas existentes.

-- CreateTable
CREATE TABLE "WhatsappTaskStageTransitionConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "resultingStageId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappTaskStageTransitionConfig_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "WhatsappTaskStageTransitionConfig" ADD CONSTRAINT "WhatsappTaskStageTransitionConfig_resultingStageId_fkey" FOREIGN KEY ("resultingStageId") REFERENCES "Stage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
