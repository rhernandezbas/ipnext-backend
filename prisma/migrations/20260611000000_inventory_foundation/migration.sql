-- ============================================================================
-- Inventory Foundation (EPIC #38, Wave 1)
-- Adds the unified asset + material ledger: StockLocation, InventoryAsset,
-- MaterialStock, InventoryMovement. Adds assetId FK on ContractInstalledItem.
-- Then runs an IDEMPOTENT data backfill: seed DEPOSITO, lazy CLIENTE locations
-- per contract, one InventoryAsset per existing CII (status=installed at the
-- contract's CLIENTE location), and one INSTALL movement per migrated asset.
--
-- Idempotency: every data step is guarded (WHERE NOT EXISTS / assetId IS NULL),
-- so re-running inserts nothing. Safe under concurrent live #19 confirm writes:
-- a CII created by the new code path already has assetId set and is skipped.
-- ============================================================================

-- ── DDL ────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "StockLocation" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "code" TEXT,
    "contractId" TEXT,
    "technicianId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryAsset" (
    "id" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "mac" TEXT,
    "deviceTypeId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "currentLocationId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceTaskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialStock" (
    "id" TEXT NOT NULL,
    "materialCatalogId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "qty" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaterialStock_pkey" PRIMARY KEY ("id"),
    -- Fix #7: DB-level guard so MaterialStock.qty can never go negative.
    -- Prisma does NOT manage CHECK constraints — this is hand-authored raw SQL.
    -- Keep this comment so a future `prisma migrate diff` does not churn/drop it.
    CONSTRAINT "MaterialStock_qty_nonneg" CHECK ("qty" >= 0)
);

-- CreateTable
CREATE TABLE "InventoryMovement" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "assetId" TEXT,
    "materialCatalogId" TEXT,
    "qty" DECIMAL(12,4),
    "fromLocationId" TEXT,
    "toLocationId" TEXT,
    "taskId" TEXT,
    "technicianId" TEXT,
    "source" TEXT NOT NULL,
    "note" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryMovement_pkey" PRIMARY KEY ("id")
);

-- AlterTable: add the dual-write link on ContractInstalledItem (nullable)
ALTER TABLE "ContractInstalledItem" ADD COLUMN "assetId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "StockLocation_code_key" ON "StockLocation"("code");
CREATE UNIQUE INDEX "StockLocation_type_contractId_key" ON "StockLocation"("type", "contractId");
CREATE UNIQUE INDEX "StockLocation_type_technicianId_key" ON "StockLocation"("type", "technicianId");
CREATE INDEX "StockLocation_type_idx" ON "StockLocation"("type");

CREATE UNIQUE INDEX "InventoryAsset_serialNumber_key" ON "InventoryAsset"("serialNumber");
CREATE INDEX "InventoryAsset_deviceTypeId_idx" ON "InventoryAsset"("deviceTypeId");
CREATE INDEX "InventoryAsset_currentLocationId_idx" ON "InventoryAsset"("currentLocationId");
CREATE INDEX "InventoryAsset_status_idx" ON "InventoryAsset"("status");
CREATE INDEX "InventoryAsset_sourceTaskId_idx" ON "InventoryAsset"("sourceTaskId");

CREATE UNIQUE INDEX "MaterialStock_materialCatalogId_locationId_key" ON "MaterialStock"("materialCatalogId", "locationId");
CREATE INDEX "MaterialStock_locationId_idx" ON "MaterialStock"("locationId");

CREATE INDEX "InventoryMovement_assetId_type_idx" ON "InventoryMovement"("assetId", "type");
CREATE INDEX "InventoryMovement_materialCatalogId_idx" ON "InventoryMovement"("materialCatalogId");
CREATE INDEX "InventoryMovement_taskId_idx" ON "InventoryMovement"("taskId");
CREATE INDEX "InventoryMovement_occurredAt_idx" ON "InventoryMovement"("occurredAt");

CREATE INDEX "ContractInstalledItem_assetId_idx" ON "ContractInstalledItem"("assetId");

-- AddForeignKey
ALTER TABLE "StockLocation" ADD CONSTRAINT "StockLocation_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockLocation" ADD CONSTRAINT "StockLocation_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "RbacUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InventoryAsset" ADD CONSTRAINT "InventoryAsset_deviceTypeId_fkey" FOREIGN KEY ("deviceTypeId") REFERENCES "DeviceTypeCatalog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryAsset" ADD CONSTRAINT "InventoryAsset_currentLocationId_fkey" FOREIGN KEY ("currentLocationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryAsset" ADD CONSTRAINT "InventoryAsset_sourceTaskId_fkey" FOREIGN KEY ("sourceTaskId") REFERENCES "ScheduledTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MaterialStock" ADD CONSTRAINT "MaterialStock_materialCatalogId_fkey" FOREIGN KEY ("materialCatalogId") REFERENCES "MaterialCatalog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MaterialStock" ADD CONSTRAINT "MaterialStock_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "InventoryAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_materialCatalogId_fkey" FOREIGN KEY ("materialCatalogId") REFERENCES "MaterialCatalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ScheduledTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "RbacUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ContractInstalledItem" ADD CONSTRAINT "ContractInstalledItem_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "InventoryAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── IDEMPOTENT DATA BACKFILL ─────────────────────────────────────────────────
-- Order matters: DEPOSITO → CLIENTE locations → assets (set CII.assetId) → INSTALL movements.

-- (Fix #8) FAIL FAST: the asset backfill falls back to the OTROS device type for any
-- CII.type that does not resolve. If OTROS is absent the backfill would insert NULL
-- deviceTypeId and violate the NOT NULL / FK — abort BEFORE writing anything.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "DeviceTypeCatalog" WHERE name = 'OTROS') THEN
    RAISE EXCEPTION 'OTROS device type required for inventory backfill';
  END IF;
END $$;

-- (a) Seed DEPOSITO singleton (one row, unique code='DEPOSITO').
INSERT INTO "StockLocation" ("id", "type", "code", "contractId", "technicianId", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'DEPOSITO', 'DEPOSITO', NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "StockLocation" WHERE "code" = 'DEPOSITO');

-- (b) Lazy CLIENTE locations: one per distinct contractId in CII that has no CLIENTE location yet.
INSERT INTO "StockLocation" ("id", "type", "code", "contractId", "technicianId", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'CLIENTE', NULL, c."contractId", NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "contractId" FROM "ContractInstalledItem") AS c
WHERE NOT EXISTS (
  SELECT 1 FROM "StockLocation" sl
  WHERE sl."type" = 'CLIENTE' AND sl."contractId" = c."contractId"
);

-- (c) One InventoryAsset per CII without an assetId (status=installed at the contract's
--     CLIENTE location). deviceType resolved by name (CII.type → DeviceTypeCatalog.name),
--     falling back to the OTROS row. serialNumber preserved; if NULL or duplicated across
--     CII rows, synthesize a stable unique placeholder from the CII id so the UNIQUE holds.
INSERT INTO "InventoryAsset" (
  "id", "serialNumber", "mac", "deviceTypeId", "status", "currentLocationId",
  "source", "sourceTaskId", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(),
  COALESCE(NULLIF(cii."serialNumber", ''), 'CII-' || cii."id"),
  cii."mac",
  COALESCE(
    -- (Fix #8) case-insensitive match: CII.type is an UPPERCASE catalog name but
    -- DeviceTypeCatalog.name casing is not guaranteed — compare upper()=upper().
    (SELECT dtc."id" FROM "DeviceTypeCatalog" dtc WHERE upper(dtc."name") = upper(cii."type")),
    (SELECT dtc2."id" FROM "DeviceTypeCatalog" dtc2 WHERE dtc2."name" = 'OTROS')
  ),
  'installed',
  cl."id",
  cii."source",
  cii."sourceTaskId",
  COALESCE(cii."confirmedAt", cii."createdAt"),
  CURRENT_TIMESTAMP
FROM "ContractInstalledItem" cii
JOIN "StockLocation" cl ON cl."type" = 'CLIENTE' AND cl."contractId" = cii."contractId"
WHERE cii."assetId" IS NULL
  AND NOT EXISTS (
    -- guard against a duplicate serialNumber already present in InventoryAsset
    SELECT 1 FROM "InventoryAsset" ia
    WHERE ia."serialNumber" = COALESCE(NULLIF(cii."serialNumber", ''), 'CII-' || cii."id")
  );

-- (d) Set CII.assetId for the rows just migrated (match by the CLIENTE-anchored asset
--     created from this CII). Idempotent: only CII rows still NULL are updated, matching the
--     asset whose synthesized/real serialNumber corresponds to that CII.
UPDATE "ContractInstalledItem" cii
SET "assetId" = ia."id"
FROM "InventoryAsset" ia
JOIN "StockLocation" cl ON cl."id" = ia."currentLocationId"
WHERE cii."assetId" IS NULL
  AND cl."type" = 'CLIENTE'
  AND cl."contractId" = cii."contractId"
  AND ia."serialNumber" = COALESCE(NULLIF(cii."serialNumber", ''), 'CII-' || cii."id");

-- (e) One INSTALL movement per migrated asset with no prior INSTALL (toLocation = CLIENTE).
INSERT INTO "InventoryMovement" (
  "id", "type", "assetId", "materialCatalogId", "qty", "fromLocationId", "toLocationId",
  "taskId", "technicianId", "source", "note", "occurredAt", "createdAt"
)
SELECT
  gen_random_uuid(), 'INSTALL', ia."id", NULL, NULL, NULL, ia."currentLocationId",
  ia."sourceTaskId", NULL, 'MIGRATION', 'W1 backfill: seeded from ContractInstalledItem',
  ia."createdAt", CURRENT_TIMESTAMP
FROM "InventoryAsset" ia
WHERE ia."status" = 'installed'
  AND EXISTS (SELECT 1 FROM "ContractInstalledItem" cii WHERE cii."assetId" = ia."id")
  AND NOT EXISTS (
    SELECT 1 FROM "InventoryMovement" mv
    WHERE mv."assetId" = ia."id" AND mv."type" = 'INSTALL'
  );
