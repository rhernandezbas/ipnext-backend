-- RENAME-ONLY, metadata-only, transactional. Preserves ALL data, FKs, indexes.
-- Renames: table Service->Contract, table ServiceTechnology->ContractTechnology,
-- table ServiceInstalledItem->ContractInstalledItem, column ScheduledTask.serviceId->contractId,
-- column ServiceInstalledItem.serviceId->contractId, + all dependent constraints/indexes.
BEGIN;

-- 1. Service -> Contract
ALTER TABLE "Service" RENAME TO "Contract";
ALTER TABLE "Contract" RENAME CONSTRAINT "Service_pkey"          TO "Contract_pkey";
ALTER TABLE "Contract" RENAME CONSTRAINT "Service_clientId_fkey" TO "Contract_clientId_fkey";
ALTER INDEX "Service_clientId_idx"     RENAME TO "Contract_clientId_idx";
ALTER INDEX "Service_status_idx"       RENAME TO "Contract_status_idx";
ALTER INDEX "Service_grContratoId_key" RENAME TO "Contract_grContratoId_key";
-- column "technology", "address","lat","lng" travel with the table (no statement needed).

-- 2. ScheduledTask.serviceId -> contractId
ALTER TABLE "ScheduledTask" RENAME COLUMN "serviceId" TO "contractId";
ALTER TABLE "ScheduledTask" RENAME CONSTRAINT "ScheduledTask_serviceId_fkey" TO "ScheduledTask_contractId_fkey";
ALTER INDEX "ScheduledTask_serviceId_idx" RENAME TO "ScheduledTask_contractId_idx";

-- 3. ServiceTechnology -> ContractTechnology
ALTER TABLE "ServiceTechnology" RENAME TO "ContractTechnology";
ALTER TABLE "ContractTechnology" RENAME CONSTRAINT "ServiceTechnology_pkey"    TO "ContractTechnology_pkey";
ALTER INDEX "ServiceTechnology_name_key" RENAME TO "ContractTechnology_name_key";

-- 4. ServiceInstalledItem -> ContractInstalledItem (+ its serviceId column)
ALTER TABLE "ServiceInstalledItem" RENAME TO "ContractInstalledItem";
ALTER TABLE "ContractInstalledItem" RENAME COLUMN "serviceId" TO "contractId";
ALTER TABLE "ContractInstalledItem" RENAME CONSTRAINT "ServiceInstalledItem_pkey"          TO "ContractInstalledItem_pkey";
ALTER TABLE "ContractInstalledItem" RENAME CONSTRAINT "ServiceInstalledItem_serviceId_fkey" TO "ContractInstalledItem_contractId_fkey";
ALTER INDEX "ServiceInstalledItem_serviceId_idx"    RENAME TO "ContractInstalledItem_contractId_idx";
ALTER INDEX "ServiceInstalledItem_serialNumber_idx" RENAME TO "ContractInstalledItem_serialNumber_idx";

COMMIT;
