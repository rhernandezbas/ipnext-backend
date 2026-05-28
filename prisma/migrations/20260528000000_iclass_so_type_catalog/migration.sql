-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "iclassSoTypeId" TEXT;

-- CreateTable
CREATE TABLE "IClassSoType" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IClassSoType_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IClassSoType_code_key" ON "IClassSoType"("code");

-- CreateIndex
CREATE INDEX "IClassSoType_active_idx" ON "IClassSoType"("active");

-- CreateIndex
CREATE INDEX "Project_iclassSoTypeId_idx" ON "Project"("iclassSoTypeId");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_iclassSoTypeId_fkey" FOREIGN KEY ("iclassSoTypeId") REFERENCES "IClassSoType"("id") ON DELETE SET NULL ON UPDATE CASCADE;
