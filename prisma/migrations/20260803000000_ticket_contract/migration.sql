-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "contractId" TEXT;

-- CreateIndex
CREATE INDEX "Ticket_contractId_idx" ON "Ticket"("contractId");

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE SET NULL ON UPDATE CASCADE;
