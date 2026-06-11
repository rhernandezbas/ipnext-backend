-- ServiceCatalog — editable catalog of contracted service types (#43).
-- Mirrors DeviceTypeCatalog. OTROS is non-deletable (enforced at the use-case layer).
CREATE TABLE "ServiceCatalog" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceCatalog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceCatalog_name_key" ON "ServiceCatalog"("name");

-- Seed: 5 base service types (idempotent — safe to replay)
INSERT INTO "ServiceCatalog" ("id","name","active","sortOrder","createdAt","updatedAt")
VALUES
  (gen_random_uuid(),'INTERNET', true, 0, now(), now()),
  (gen_random_uuid(),'TV',       true, 1, now(), now()),
  (gen_random_uuid(),'VOZ',      true, 2, now(), now()),
  (gen_random_uuid(),'CAMARAS',  true, 3, now(), now()),
  (gen_random_uuid(),'OTROS',    true, 4, now(), now())
ON CONFLICT (name) DO NOTHING;

-- ContractService — pivot linking a Contract to a ServiceCatalog entry.
CREATE TABLE "ContractService" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "serviceCatalogId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractService_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ContractService_contractId_serviceCatalogId_key" ON "ContractService"("contractId", "serviceCatalogId");

-- CreateIndex
CREATE INDEX "ContractService_contractId_idx" ON "ContractService"("contractId");

-- AddForeignKey: deleting a contract cascades its services.
ALTER TABLE "ContractService" ADD CONSTRAINT "ContractService_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: a catalog entry in use cannot be deleted (RESTRICT).
ALTER TABLE "ContractService" ADD CONSTRAINT "ContractService_serviceCatalogId_fkey" FOREIGN KEY ("serviceCatalogId") REFERENCES "ServiceCatalog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
