-- #48: Reporter on Ticket — quien creo el ticket. Aditivo, nullable, sin backfill.
-- Tickets viejos quedan reporterId = NULL (FE muestra "—"). Lo nuevo se estampa en create.

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "reporterId" TEXT;

-- CreateIndex
CREATE INDEX "Ticket_reporterId_idx" ON "Ticket"("reporterId");

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "RbacUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
