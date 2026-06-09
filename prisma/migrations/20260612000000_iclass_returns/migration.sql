-- ============================================================================
-- Closure-Detected Equipment Returns to Depot (EPIC #38, Wave 4)
--
-- Additive, reversible, NO backfill (staging is forward-only):
--   1) ReturnSuggestion table (+ indexes + @@unique([serviceOrderId, serialNumber]))
--   2) IClassServiceOrder.inventoryReturnsProcessed  (L1 idempotency flag)
--   3) IClassResultCode.isRemovalCode                (configurable removal-code gate)
--   4) InventoryMovement.sourceRef + PARTIAL UNIQUE  (L2 idempotency, NULL-safe)
--   5) Seed isRemovalCode=true for the 2 confirmed removal codes
--
-- Idempotency: every statement is guarded (IF NOT EXISTS / WHERE …) so re-running
-- this migration is a no-op. The sourceRef UNIQUE is a HAND-WRITTEN partial index
-- (WHERE "sourceRef" IS NOT NULL): a plain Prisma @@unique would index the many
-- legacy NULL rows and collide. DO NOT replace it with @@unique in schema.prisma.
-- ============================================================================

-- ── 1) ReturnSuggestion table ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ReturnSuggestion" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "serviceOrderId" TEXT NOT NULL,
    "serialNumber" TEXT,
    "mac" TEXT,
    "deviceType" TEXT,
    "matchedAssetId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resolution" TEXT,
    "confirmedMovementId" TEXT,
    -- Fix #5 (W4 review): the L2 natural key `iclass:return:{assetId}` lives in its OWN
    -- column. confirmedMovementId now holds the real movement.id (uuid); findBySourceRef
    -- keys on this column. Added idempotently below for forward-only re-runs.
    "sourceRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReturnSuggestion_pkey" PRIMARY KEY ("id")
);

-- Guarded ADD for an existing table (the CREATE above is skipped on re-run via IF NOT EXISTS).
ALTER TABLE "ReturnSuggestion" ADD COLUMN IF NOT EXISTS "sourceRef" TEXT;

-- One suggestion per (SO, serial) — silently dedups a partial-crash re-stage.
CREATE UNIQUE INDEX IF NOT EXISTS "ReturnSuggestion_serviceOrderId_serialNumber_key"
    ON "ReturnSuggestion"("serviceOrderId", "serialNumber");
CREATE INDEX IF NOT EXISTS "ReturnSuggestion_status_idx" ON "ReturnSuggestion"("status");
CREATE INDEX IF NOT EXISTS "ReturnSuggestion_taskId_idx" ON "ReturnSuggestion"("taskId");
-- findBySourceRef lookup (Fix #3/#5).
CREATE INDEX IF NOT EXISTS "ReturnSuggestion_sourceRef_idx" ON "ReturnSuggestion"("sourceRef");

-- FKs (guarded — DO $$ skips re-add on re-run).
DO $$ BEGIN
    ALTER TABLE "ReturnSuggestion"
        ADD CONSTRAINT "ReturnSuggestion_taskId_fkey"
        FOREIGN KEY ("taskId") REFERENCES "ScheduledTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "ReturnSuggestion"
        ADD CONSTRAINT "ReturnSuggestion_matchedAssetId_fkey"
        FOREIGN KEY ("matchedAssetId") REFERENCES "InventoryAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2) IClassServiceOrder.inventoryReturnsProcessed (L1 idempotency) ─────────
ALTER TABLE "IClassServiceOrder"
    ADD COLUMN IF NOT EXISTS "inventoryReturnsProcessed" BOOLEAN NOT NULL DEFAULT false;

-- ── 3) IClassResultCode.isRemovalCode (configurable removal-code gate) ───────
ALTER TABLE "IClassResultCode"
    ADD COLUMN IF NOT EXISTS "isRemovalCode" BOOLEAN NOT NULL DEFAULT false;

-- ── 4) InventoryMovement.sourceRef + PARTIAL UNIQUE (L2 idempotency) ─────────
ALTER TABLE "InventoryMovement"
    ADD COLUMN IF NOT EXISTS "sourceRef" TEXT;

-- PARTIAL unique — only non-NULL sourceRef values are constrained, so the many
-- legacy rows (sourceRef IS NULL) never collide. Hand-written; see schema.prisma note.
CREATE UNIQUE INDEX IF NOT EXISTS "InventoryMovement_sourceRef_key"
    ON "InventoryMovement"("sourceRef")
    WHERE "sourceRef" IS NOT NULL;

-- ── 5) Seed the 2 confirmed removal codes (idempotent UPDATE) ────────────────
UPDATE "IClassResultCode"
    SET "isRemovalCode" = true
    WHERE "code" IN ('Retiro completo Servicio Fibra', 'Retiro completo Servicio Wireless');
