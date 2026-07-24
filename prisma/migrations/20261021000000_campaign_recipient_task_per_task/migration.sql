-- bulk-task-stage-transition (B3, TRANS-5) — CampaignRecipient pasa a granularidad PER-TAREA.
--
-- SEGURIDAD (por qué NO hay pérdida ni transformación de datos):
--  * Las 3 columnas nuevas son NULLABLE y aditivas (default NULL) → filas existentes intactas.
--  * Se REEMPLAZA @@unique([campaignId, clientId]) por @@unique([campaignId, taskId]).
--    Postgres trata cada NULL como DISTINTO en un unique index, así que:
--      - las filas existentes (y toda fila no-task futura) tienen taskId = NULL → NUNCA colisionan
--        entre sí (equivale a un unique PARCIAL WHERE taskId IS NOT NULL, sin SQL a mano).
--      - la nueva constraint no puede fallar sobre los datos actuales (todos taskId NULL).
--  * El dedup por cliente de los otros dominios (segmento/manual/csv) lo garantiza
--    resolveCombinedRecipients (byClientId), ya no la constraint de DB.
--  * SIN BEGIN/COMMIT: `prisma migrate deploy` envuelve cada migración en su transacción.

-- DropIndex — la constraint vieja por cliente (un cliente ahora aparece N veces, una por tarea)
DROP INDEX "CampaignRecipient_campaignId_clientId_key";

-- AlterTable — columnas nuevas (aditivas, nullable)
ALTER TABLE "CampaignRecipient" ADD COLUMN     "taskFromStageId" TEXT,
ADD COLUMN     "taskId" TEXT,
ADD COLUMN     "taskResultingStageId" TEXT;

-- CreateIndex — unique per-tarea (NULLs distintos = unique parcial de facto)
CREATE UNIQUE INDEX "CampaignRecipient_campaignId_taskId_key" ON "CampaignRecipient"("campaignId", "taskId");

-- AddForeignKey — taskId → ScheduledTask, SetNull (si la tarea se borra, el recipient sobrevive)
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ScheduledTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;
