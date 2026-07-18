-- Migration: 20260925000000_conversation_last_public_message_direction
-- inbox-views (Ola 1): vista "Sin atender" + contadores por vista del inbox.
-- ADITIVA y de bajo riesgo: ADD COLUMN nullable (sin default — NULL = "sin mensajes
-- públicos todavía") + CREATE INDEX + backfill set-based e idempotente desde el
-- último ChatMessage NO-privado por conversación. El cache lo mantiene en runtime
-- PrismaChatMessageRepository.syncConversationDirection (choke point de los 5
-- write-paths de mensajes: webhook / fetch-on-open / send / bulk / template).
-- No explicit transaction block (Prisma wraps each migration in its own transaction).

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "lastPublicMessageDirection" TEXT;

-- CreateIndex
CREATE INDEX "Conversation_lastPublicMessageDirection_idx" ON "Conversation"("lastPublicMessageDirection");

-- Backfill: dirección del ÚLTIMO mensaje NO-privado por conversación. Criterio de
-- "último" = (chatwootCreatedAt DESC, id DESC) — espejo EXACTO del orderBy del
-- recompute del adapter (listByConversation ASC invertido); una nota interna
-- (isPrivate) JAMÁS define la dirección (no cuenta como atención, NOTE-3).
-- Conversaciones sin mensajes públicos quedan NULL (fuera del bucket Sin atender).
-- Set-based, idempotente, best-effort: SIN guard que aborte el deploy.
UPDATE "Conversation" AS c
SET "lastPublicMessageDirection" = m."direction"
FROM (
  SELECT DISTINCT ON ("conversationId") "conversationId", "direction"
  FROM "ChatMessage"
  WHERE "isPrivate" = false
  ORDER BY "conversationId", "chatwootCreatedAt" DESC, "id" DESC
) AS m
WHERE m."conversationId" = c."id";
