-- AddMinStockToMaterialCatalog + InventoryMovement composite index
-- Wave 7 (Capstone) — ADDITIVE ONLY, no drops, idempotent guards.

ALTER TABLE "MaterialCatalog" ADD COLUMN IF NOT EXISTS "minStock" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "InventoryMovement_type_occurredAt_idx" ON "InventoryMovement"("type","occurredAt" DESC);
