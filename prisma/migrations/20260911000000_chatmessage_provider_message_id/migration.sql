-- Migration: 20260911000000_chatmessage_provider_message_id
-- inbox-template-send (MODEL-1): ChatMessage.providerMessageId — SM sid de Twilio,
-- clave de idempotencia del envío one-off de template desde el hilo
-- (upsertTemplateMessage). ADITIVA y de bajo riesgo: ADD COLUMN nullable +
-- CREATE UNIQUE INDEX (PG trata NULLs como distintos → las filas chatwoot/bulk
-- existentes quedan NULL sin chocar entre sí).
-- Generado con: npx prisma migrate diff --from-schema <HEAD:schema> --to-schema
--               prisma/schema.prisma --script (sin DB viva: diff estático entre
--               dos snapshots del schema, molde 20260909000000_bulk_inbox_projection).
-- No explicit transaction block (Prisma wraps each migration in its own transaction).

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "providerMessageId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_providerMessageId_key" ON "ChatMessage"("providerMessageId");
