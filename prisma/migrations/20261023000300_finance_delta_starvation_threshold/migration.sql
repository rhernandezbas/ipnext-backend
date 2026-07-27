-- fix-wave-2 LOW — DELTA_STARVATION_THRESHOLD was hardcoded in
-- FinanceReceiptIngestScheduler while F6 argues the whole pacing model should
-- be editable in DB without a redeploy (Decision 4b). 100% ADITIVA: one
-- nullable-safe column with a default, no data migration needed.

-- AlterTable
ALTER TABLE "FinanceReceiptSyncConfig" ADD COLUMN "deltaStarvationThreshold" INTEGER NOT NULL DEFAULT 3;
