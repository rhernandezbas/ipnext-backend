-- AlterTable
ALTER TABLE "ScheduledTask" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'customer',
ADD COLUMN     "networkSiteId" TEXT;

-- AlterTable
ALTER TABLE "NetworkSite" ADD COLUMN     "iclassNodeCode" TEXT;

-- CreateIndex
CREATE INDEX "ScheduledTask_networkSiteId_idx" ON "ScheduledTask"("networkSiteId");

-- AddForeignKey
ALTER TABLE "ScheduledTask" ADD CONSTRAINT "ScheduledTask_networkSiteId_fkey" FOREIGN KEY ("networkSiteId") REFERENCES "NetworkSite"("id") ON DELETE SET NULL ON UPDATE CASCADE;
