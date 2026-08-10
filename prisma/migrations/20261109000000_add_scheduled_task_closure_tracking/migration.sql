-- AlterTable
ALTER TABLE "ScheduledTask" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "closedByUserId" TEXT,
ADD COLUMN     "closureOrigin" TEXT,
ADD COLUMN     "closureResultCode" TEXT;

-- AddForeignKey
ALTER TABLE "ScheduledTask" ADD CONSTRAINT "ScheduledTask_closedByUserId_fkey" FOREIGN KEY ("closedByUserId") REFERENCES "RbacUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
