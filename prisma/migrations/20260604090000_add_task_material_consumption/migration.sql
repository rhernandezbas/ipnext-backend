-- CreateTable
CREATE TABLE "TaskMaterialConsumption" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "materialCatalogId" TEXT NOT NULL,
    "materialName" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT,
    "notes" TEXT,
    "recordedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskMaterialConsumption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaskMaterialConsumption_taskId_idx" ON "TaskMaterialConsumption"("taskId");

-- AddForeignKey
ALTER TABLE "TaskMaterialConsumption" ADD CONSTRAINT "TaskMaterialConsumption_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ScheduledTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskMaterialConsumption" ADD CONSTRAINT "TaskMaterialConsumption_materialCatalogId_fkey" FOREIGN KEY ("materialCatalogId") REFERENCES "MaterialCatalog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskMaterialConsumption" ADD CONSTRAINT "TaskMaterialConsumption_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "RbacUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
