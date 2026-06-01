-- AlterTable
ALTER TABLE "IClassSoChecklistAnswer" ADD COLUMN     "photoUrl" TEXT;

-- CreateTable
CREATE TABLE "OcrExtraction" (
    "id" TEXT NOT NULL,
    "photoUrl" TEXT NOT NULL,
    "serviceOrderId" TEXT,
    "sourceTaskId" TEXT,
    "deviceType" TEXT,
    "sn" TEXT,
    "mac" TEXT,
    "confidence" DOUBLE PRECISION,
    "rawOutput" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'ollama:gemma3:12b',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OcrExtraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskInventorySuggestion" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "deviceType" TEXT,
    "serialNumber" TEXT,
    "mac" TEXT,
    "materialDesc" TEXT,
    "quantity" DOUBLE PRECISION,
    "unit" TEXT,
    "source" TEXT NOT NULL,
    "photoUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "confirmedItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskInventorySuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceInstalledItem" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "serialNumber" TEXT,
    "mac" TEXT,
    "model" TEXT,
    "source" TEXT NOT NULL,
    "sourceTaskId" TEXT,
    "addedByUserId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceInstalledItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OcrExtraction_sourceTaskId_idx" ON "OcrExtraction"("sourceTaskId");

-- CreateIndex
CREATE INDEX "TaskInventorySuggestion_taskId_status_idx" ON "TaskInventorySuggestion"("taskId", "status");

-- CreateIndex
CREATE INDEX "ServiceInstalledItem_serviceId_idx" ON "ServiceInstalledItem"("serviceId");

-- CreateIndex
CREATE INDEX "ServiceInstalledItem_serialNumber_idx" ON "ServiceInstalledItem"("serialNumber");

-- AddForeignKey
ALTER TABLE "TaskInventorySuggestion" ADD CONSTRAINT "TaskInventorySuggestion_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ScheduledTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceInstalledItem" ADD CONSTRAINT "ServiceInstalledItem_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;
