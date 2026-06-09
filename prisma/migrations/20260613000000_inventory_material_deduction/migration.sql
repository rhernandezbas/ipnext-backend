-- ============================================================================
-- Inventory Material Deduction (EPIC #38, Wave 6)
--
-- Semi-automatic stage→confirm pipeline that decrements a technician's TECNICO
-- stock when a task records material consumption. Operator-controlled, flag-gated.
--
-- Additive, reversible, NO backfill:
--   1) MaterialDeductionSuggestion table + indexes + UNIQUE(taskMaterialConsumptionId)
--   2) TaskMaterialConsumption.deductedAt / deductedMovementId  (nullable link columns)
--   3) Seed `inventory-material-auto-deduct` flag  (value false, default OFF)
--
-- NOTE: InventoryMovement.sourceRef partial unique (WHERE sourceRef IS NOT NULL) is
-- REUSED from Wave 4 migration (20260612000000_iclass_returns/migration.sql).
-- DO NOT recreate it here — it already covers `consume:task-material:{id}` keys.
--
-- Idempotency: every statement uses IF NOT EXISTS / ON CONFLICT DO NOTHING so
-- re-running this migration is a no-op.
-- ============================================================================

-- ── 1) MaterialDeductionSuggestion table ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS "MaterialDeductionSuggestion" (
    "id"                       TEXT NOT NULL,
    -- L1 idempotency: one consumption → at most one suggestion (UNIQUE)
    "taskMaterialConsumptionId" TEXT NOT NULL,
    "taskId"                   TEXT NOT NULL,
    -- technicianId may be null when the task has no assignee at stage time
    "technicianId"             TEXT,
    "materialCatalogId"        TEXT NOT NULL,
    "qty"                      DECIMAL(12,4) NOT NULL,
    -- technicianLocationId may be null when assignee has no TECNICO location
    "technicianLocationId"     TEXT,
    "status"                   TEXT NOT NULL DEFAULT 'pending',
    "resolution"               TEXT,
    -- L2 natural key: consume:task-material:{consumptionId}
    "sourceRef"                TEXT,
    "deductedMovementId"       TEXT,
    "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaterialDeductionSuggestion_pkey" PRIMARY KEY ("id")
);

-- L1: one consumption → one suggestion (dedup on re-stage / partial-crash retry)
CREATE UNIQUE INDEX IF NOT EXISTS "MaterialDeductionSuggestion_consumptionId_key"
    ON "MaterialDeductionSuggestion"("taskMaterialConsumptionId");

-- Mirrors schema `deductedMovementId @unique` (one movement ↔ one suggestion; NULLs allowed)
CREATE UNIQUE INDEX IF NOT EXISTS "MaterialDeductionSuggestion_deductedMovementId_key"
    ON "MaterialDeductionSuggestion"("deductedMovementId");

-- Standard lookup indexes
CREATE INDEX IF NOT EXISTS "MaterialDeductionSuggestion_status_idx"
    ON "MaterialDeductionSuggestion"("status");
CREATE INDEX IF NOT EXISTS "MaterialDeductionSuggestion_taskId_idx"
    ON "MaterialDeductionSuggestion"("taskId");
CREATE INDEX IF NOT EXISTS "MaterialDeductionSuggestion_sourceRef_idx"
    ON "MaterialDeductionSuggestion"("sourceRef");

-- FKs (guarded — DO $$ skips re-add on re-run).
DO $$ BEGIN
    ALTER TABLE "MaterialDeductionSuggestion"
        ADD CONSTRAINT "MaterialDeductionSuggestion_taskId_fkey"
        FOREIGN KEY ("taskId") REFERENCES "ScheduledTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "MaterialDeductionSuggestion"
        ADD CONSTRAINT "MaterialDeductionSuggestion_consumptionId_fkey"
        FOREIGN KEY ("taskMaterialConsumptionId") REFERENCES "TaskMaterialConsumption"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "MaterialDeductionSuggestion"
        ADD CONSTRAINT "MaterialDeductionSuggestion_materialCatalogId_fkey"
        FOREIGN KEY ("materialCatalogId") REFERENCES "MaterialCatalog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- deductedMovementId SET NULL (movement deleted should not cascade-delete the suggestion)
DO $$ BEGIN
    ALTER TABLE "MaterialDeductionSuggestion"
        ADD CONSTRAINT "MaterialDeductionSuggestion_deductedMovementId_fkey"
        FOREIGN KEY ("deductedMovementId") REFERENCES "InventoryMovement"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2) TaskMaterialConsumption — additive nullable link columns ───────────────

ALTER TABLE "TaskMaterialConsumption"
    ADD COLUMN IF NOT EXISTS "deductedAt" TIMESTAMP(3);

ALTER TABLE "TaskMaterialConsumption"
    ADD COLUMN IF NOT EXISTS "deductedMovementId" TEXT;

-- ── 3) Seed inventory-material-auto-deduct flag (default OFF) ─────────────────

INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
    VALUES ('inventory-material-auto-deduct', false, NOW())
    ON CONFLICT ("key") DO NOTHING;
