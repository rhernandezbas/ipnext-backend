-- pppoe-change-audit: audita cambios de IP / password / status de un PPPoE al historial del cliente.
-- Aditiva (3 columnas nullable) → segura, sin backfill, sin transacción manual.
-- AlterTable
ALTER TABLE "contract_service_events" ADD COLUMN     "changeKind" TEXT,
ADD COLUMN     "newValue" TEXT,
ADD COLUMN     "oldValue" TEXT;
