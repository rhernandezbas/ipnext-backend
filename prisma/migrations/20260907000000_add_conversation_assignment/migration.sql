-- F1.5-C2 (asignación) — assigneeId/areaId son campos LOCALES del mirror Conversation:
-- Chatwoot NUNCA se entera de la asignación (no hay llamada upstream), igual que
-- status/canReply ya son locales-primero. Aditiva, sin backfill — clon 1:1 del patrón
-- Ticket.assigneeId/areaId (20260527080000_add_ticket_model +
-- 20260529100000_task_fk_admin_to_rbacuser + 20260704000000_ticket_area_catalog).

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "assigneeId" TEXT;
ALTER TABLE "Conversation" ADD COLUMN     "areaId" TEXT;

-- CreateIndex
CREATE INDEX "Conversation_assigneeId_idx" ON "Conversation"("assigneeId");

-- CreateIndex
CREATE INDEX "Conversation_areaId_idx" ON "Conversation"("areaId");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "RbacUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "TicketAreaCatalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
