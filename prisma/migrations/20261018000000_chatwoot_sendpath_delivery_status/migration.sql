-- Migration: 20261018000000_chatwoot_sendpath_delivery_status
-- chatwoot-hub-sendpath (design D6/D10) — schema aditivo del delta:
--
-- 1. ChatMessage.deliveryStatus/deliveryError (D6) — proyeccion de `message_updated`/
--    `content_attributes.external_error` del webhook de Chatwoot: `deliveryStatus` queda
--    NULL (default = entregado a Chatwoot / desconocido) o 'failed'; `deliveryError` trae
--    el texto curado (sin headers/body crudos, HIST-3). delivered/read siguen INVISIBLES
--    (paridad con hoy, decision B de la proposal - no es regresion). Nullable, SIN default:
--    aditiva, no toca ninguna fila existente ni ningun path OFF.
-- 2. Seed idempotente del feature flag 'messaging-send-via-chatwoot' (default OFF, D10) -
--    molde 20260917000100_radius_auto_cure_flag / 20260905000100_chat_media_download_flag.
--    Sin este seed la UI de feature flags no lo muestra y el operador no puede togglearlo.
--
-- Generado con: npx prisma migrate diff --from-schema <HEAD:schema.prisma>
--               --to-schema prisma/schema.prisma --script (Prisma 7, sin DB viva) + el
--               INSERT idempotente agregado a mano (mismo criterio que las migraciones
--               hermanas de seed de flags). Timestamp posterior a la ultima migracion en
--               el repo al momento de este batch (20261017000000_messaging_bulk_status_permissions).
-- No explicit transaction block (Prisma wraps each migration in its own transaction).

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "deliveryError" TEXT,
ADD COLUMN     "deliveryStatus" TEXT;

-- Feature flag: messaging-send-via-chatwoot (default OFF). Idempotente: ON CONFLICT DO
-- NOTHING sobre el PK "key".
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('messaging-send-via-chatwoot', false, NOW())
ON CONFLICT DO NOTHING;
