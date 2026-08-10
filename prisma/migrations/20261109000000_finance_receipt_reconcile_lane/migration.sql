-- gr-receipt-annulment (design.md Decision 7) — third ingest lane ("reconcile")
-- + systemic annulment guard. 100% ADITIVA: five nullable-safe columns with
-- defaults, no data migration needed. The singleton row in prod inherits the
-- defaults, so the lane starts ENABLED (35d window, 6h cadence) with no
-- operator action required.

-- AlterTable
ALTER TABLE "FinanceReceiptSyncConfig" ADD COLUMN     "annulmentGuardMaxPct" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "annulmentGuardMinCount" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "reconcileCheckIntervalMs" INTEGER NOT NULL DEFAULT 21600000,
ADD COLUMN     "reconcileEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "reconcileWindowDays" INTEGER NOT NULL DEFAULT 35;
