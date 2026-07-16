-- AlterTable
ALTER TABLE "Contract" ADD COLUMN     "accessPointId" TEXT,
ADD COLUMN     "networkSiteId" TEXT;

-- CreateTable
CREATE TABLE "AccessPoint" (
    "id" TEXT NOT NULL,
    "uispDeviceId" TEXT NOT NULL,
    "networkSiteId" TEXT,
    "name" TEXT NOT NULL,
    "mac" TEXT,
    "missingSince" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessPoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccessPoint_uispDeviceId_key" ON "AccessPoint"("uispDeviceId");

-- CreateIndex
CREATE INDEX "AccessPoint_networkSiteId_idx" ON "AccessPoint"("networkSiteId");

-- CreateIndex
CREATE INDEX "Contract_networkSiteId_idx" ON "Contract"("networkSiteId");

-- CreateIndex
CREATE INDEX "Contract_accessPointId_idx" ON "Contract"("accessPointId");

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_networkSiteId_fkey" FOREIGN KEY ("networkSiteId") REFERENCES "NetworkSite"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_accessPointId_fkey" FOREIGN KEY ("accessPointId") REFERENCES "AccessPoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessPoint" ADD CONSTRAINT "AccessPoint_networkSiteId_fkey" FOREIGN KEY ("networkSiteId") REFERENCES "NetworkSite"("id") ON DELETE SET NULL ON UPDATE CASCADE;
