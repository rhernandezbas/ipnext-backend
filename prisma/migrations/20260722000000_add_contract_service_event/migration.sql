-- CreateTable
CREATE TABLE "contract_service_events" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "serviceCatalogId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT NOT NULL DEFAULT '',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_service_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contract_service_events_contractId_createdAt_idx" ON "contract_service_events"("contractId", "createdAt");

-- AddForeignKey
ALTER TABLE "contract_service_events" ADD CONSTRAINT "contract_service_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "RbacUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_service_events" ADD CONSTRAINT "contract_service_events_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;
