-- Migration: client_balance_fields
-- Additive: 3 nullable columns on Client for the GR debtor-balance feature.
-- Safe to apply without downtime — all nullable, no index.

ALTER TABLE "Client" ADD COLUMN "balanceDue"      DECIMAL(12,2);
ALTER TABLE "Client" ADD COLUMN "balanceCurrency" TEXT;
ALTER TABLE "Client" ADD COLUMN "lastBalanceAt"   TIMESTAMP(3);
