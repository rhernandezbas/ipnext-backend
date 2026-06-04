-- AlterTable
ALTER TABLE "IClassServiceOrder" ADD COLUMN     "auditAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "auditDone" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "commentPosted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "inventoryBuilt" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastAuditAttemptAt" TIMESTAMP(3);
