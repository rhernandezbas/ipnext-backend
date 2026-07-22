-- Migration: 20261019000000_task_stage_recipient_config
-- bulk-task-recipients (design D1, TSC-1) — 5to dominio de destinatarios del bulk WhatsApp:
-- "Tarea" (clientes con >=1 tarea ABIERTA en un Stage mapeado).
--
-- 1. WhatsappTaskStageRecipientConfig — set de Stages elegibles (una fila POR stage
--    mapeado, NO `stageIds String[]` crudo: la FK real evita ids huerfanos). `stageId`
--    UNIQUE = idempotencia del mapeo. `onDelete: Cascade` — borrar el Stage limpia el
--    mapeo solo, sin job de limpieza.
-- 2. Indice compuesto ADITIVO en ScheduledTask (stageId, isClosed, customerId) — covering
--    para la resolucion de destinatarios: index-only scan para el DISTINCT(customerId) y
--    para el count de customerId IS NULL. El @@index([stageId]) existente se CONSERVA
--    (otros paths de scheduling lo usan).
--
-- 100% ADITIVA: CERO cambio en Campaign/CampaignRecipient (clientId ya nullable de
-- bulk-csv-recipients). Sin backfill.
--
-- Generado con: npx prisma migrate diff --from-schema <HEAD:schema.prisma>
--               --to-schema prisma/schema.prisma --script (Prisma 7, sin DB viva).
--               Timestamp posterior a la ultima migracion en el repo al momento de este
--               batch (20261018000000_chatwoot_sendpath_delivery_status).
-- No explicit transaction block (Prisma wraps each migration in its own transaction).

-- CreateTable
CREATE TABLE "WhatsappTaskStageRecipientConfig" (
    "id" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsappTaskStageRecipientConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappTaskStageRecipientConfig_stageId_key" ON "WhatsappTaskStageRecipientConfig"("stageId");

-- CreateIndex
CREATE INDEX "ScheduledTask_stageId_isClosed_customerId_idx" ON "ScheduledTask"("stageId", "isClosed", "customerId");

-- AddForeignKey
ALTER TABLE "WhatsappTaskStageRecipientConfig" ADD CONSTRAINT "WhatsappTaskStageRecipientConfig_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "Stage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
