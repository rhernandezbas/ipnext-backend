-- AlterTable
ALTER TABLE "ScheduledTask" ADD COLUMN     "reviewedByInventoryAt" TIMESTAMP(3),
ADD COLUMN     "reviewedByInventoryUserId" TEXT;

-- AddForeignKey
ALTER TABLE "ScheduledTask" ADD CONSTRAINT "ScheduledTask_reviewedByInventoryUserId_fkey" FOREIGN KEY ("reviewedByInventoryUserId") REFERENCES "RbacUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
