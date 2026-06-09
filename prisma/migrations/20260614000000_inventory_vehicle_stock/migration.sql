-- ============================================================================
-- Inventory Vehicle Stock (EPIC #38, Wave 5b)
--
-- Additive, no backfill:
--   1) Vehicle table + plate UNIQUE index
--   2) StockLocation.vehicleId nullable FK + compound unique (type, vehicleId)
--   3) CAMIONETA is a new value for the `type` string column (no enum change in SQL)
--
-- NOTE: StockLocation.type is a TEXT column (not a Postgres enum), so adding
-- CAMIONETA requires no ALTER TYPE — new rows simply use the new string value.
--
-- Schema↔SQL parity:
--   - updatedAt TIMESTAMP(3) NOT NULL — NO DEFAULT (Prisma's @updatedAt writes it)
--   - createdAt TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
--   - status    TEXT NOT NULL DEFAULT 'active'
--   - FK vehicleId ON DELETE CASCADE
--   - FK assignedTechnicianId ON DELETE SET NULL
--
-- Idempotency: every statement uses IF NOT EXISTS / DO $$ for re-run safety.
-- ============================================================================

-- ── 1) Vehicle table ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "Vehicle" (
    "id"                    TEXT NOT NULL,
    "plate"                 TEXT NOT NULL,
    "name"                  TEXT,
    "assignedTechnicianId"  TEXT,
    "status"                TEXT NOT NULL DEFAULT 'active',
    "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- plate must be globally unique
CREATE UNIQUE INDEX IF NOT EXISTS "Vehicle_plate_key"
    ON "Vehicle"("plate");

-- FK: assignedTechnicianId → RbacUser (SET NULL on delete — parking a truck doesn't delete it)
DO $$ BEGIN
    ALTER TABLE "Vehicle"
        ADD CONSTRAINT "Vehicle_assignedTechnicianId_fkey"
        FOREIGN KEY ("assignedTechnicianId") REFERENCES "RbacUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2) StockLocation.vehicleId — additive nullable column ────────────────────

ALTER TABLE "StockLocation"
    ADD COLUMN IF NOT EXISTS "vehicleId" TEXT;

-- FK: vehicleId → Vehicle (CASCADE — deleting a vehicle drops its location)
DO $$ BEGIN
    ALTER TABLE "StockLocation"
        ADD CONSTRAINT "StockLocation_vehicleId_fkey"
        FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Compound unique: at most one CAMIONETA per vehicle.
-- PG treats NULLs as distinct → existing DEPOSITO/CLIENTE/TECNICO rows (vehicleId NULL)
-- never collide. Named to match Prisma's generated index name.
CREATE UNIQUE INDEX IF NOT EXISTS "StockLocation_type_vehicleId_key"
    ON "StockLocation"("type", "vehicleId");
