-- Migration: 20260921000000_chatmessage_idempotency_key
-- inbox-template-send (fix wave, H1 — idempotency-key server-side):
-- ChatMessage.idempotencyKey — clave de idempotencia PROPIA del request HTTP
-- (UUID generado por el FE al abrir el confirm), DISTINTA de providerMessageId
-- (que es el SM sid de Twilio, solo se conoce DESPUES del envío). Protege contra
-- doble costo real: un timeout de red tras el accept de Twilio + reintento del
-- operador reusa la MISMA key -> se devuelve el mensaje ya proyectado en vez de
-- re-enviar. ADITIVA y de bajo riesgo: ADD COLUMN nullable + CREATE UNIQUE INDEX
-- (PG trata NULLs como distintos -> las filas existentes y los request de un FE
-- viejo sin key quedan NULL sin chocar entre sí).
--
-- Timestamp elegido POSTERIOR a TODAS las migraciones hermanas detectadas en
-- worktrees en vuelo al momento de este fix wave (2026-07-16): la más nueva
-- localmente era 20260911000000 (chatmessage_provider_message_id, este mismo
-- change), pero bulk-csv-recipients-be ya tenía 20260920000000 -- se usa
-- 20260921000000 para no colisionar con esa ni con ninguna otra en vuelo
-- (inbox-resolve 20260910000000, internal-news 20260911000000, node-ap-assign
-- 20260916000100, radius-autocure 20260917000100).
--
-- Generado con: npx prisma migrate diff --from-schema <HEAD:schema.prisma>
--               --to-schema prisma/schema.prisma --script (sin DB viva: diff
--               estático entre dos snapshots del schema, molde
--               20260911000000_chatmessage_provider_message_id — mismo criterio,
--               CERO SQL a mano). Migración pendiente de `prisma migrate deploy`
--               en un entorno con DB real antes de mergear a producción.
-- No explicit transaction block (Prisma wraps each migration in its own transaction).

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_idempotencyKey_key" ON "ChatMessage"("idempotencyKey");
