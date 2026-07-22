-- Migration: 20261019000000_campaign_chatwoot_label
-- campaign-chatwoot-label (design D3/CLBL-6) — campo aditivo pass-through:
-- title del label REAL de Chatwoot elegido opcionalmente al crear una campaña
-- bulk. Nullable, SIN default, SIN backfill: aditiva, no toca ninguna fila
-- existente ni ningun path OFF (campanias viejas quedan NULL = sin label,
-- comportamiento actual exacto).
--
-- Generado con: npx prisma migrate diff --from-schema <HEAD:schema.prisma>
--               --to-schema prisma/schema.prisma --script (Prisma 7, sin DB
--               viva). Timestamp posterior a la ultima migracion en el repo al
--               momento de este batch (20261018000000_chatwoot_sendpath_delivery_status).
-- No explicit transaction block (Prisma wraps each migration in its own transaction).

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "chatwootLabel" TEXT;
