-- Migration: 20260930000000_conversation_mentions
-- note-mentions (Ola 6b, EPIC inbox-Chatwoot) — @menciones en notas internas + vista
-- "Menciones": tabla ConversationMention (una fila por usuario mencionado en una nota).
--
-- 100% ADITIVA y de bajo riesgo: un solo CREATE TABLE + índices + FKs (Cascade/SetNull).
-- SIN backfill (no existió el concepto de mención hasta esta migración — no hay data que
-- reconstruir). Sin BEGIN/COMMIT explícito (Prisma envuelve cada migración en su propia
-- transacción).

-- ─── 1. ConversationMention: una @mención en una nota interna ─────────────────────
CREATE TABLE "ConversationMention" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "mentionedUserId" TEXT NOT NULL,
    "mentionedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- NULL = no leída (aparece en la vista "Menciones"); ISO al marcar leída (sale de la vista).
    "readAt" TIMESTAMP(3),

    CONSTRAINT "ConversationMention_pkey" PRIMARY KEY ("id")
);

-- ─── 2. Índices ───────────────────────────────────────────────────────────────────
-- Idempotencia: el mismo usuario nombrado dos veces en la misma nota registra 1 sola fila.
CREATE UNIQUE INDEX "ConversationMention_messageId_mentionedUserId_key" ON "ConversationMention"("messageId", "mentionedUserId");
CREATE INDEX "ConversationMention_conversationId_idx" ON "ConversationMention"("conversationId");
-- Sirve el subquery de la vista/count "Menciones": menciones NO leídas por usuario.
CREATE INDEX "ConversationMention_mentionedUserId_readAt_idx" ON "ConversationMention"("mentionedUserId", "readAt");

-- ─── 3. FKs (conversación + nota Cascade; usuario mencionado Cascade; autor SetNull) ─
ALTER TABLE "ConversationMention" ADD CONSTRAINT "ConversationMention_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationMention" ADD CONSTRAINT "ConversationMention_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationMention" ADD CONSTRAINT "ConversationMention_mentionedUserId_fkey" FOREIGN KEY ("mentionedUserId") REFERENCES "RbacUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationMention" ADD CONSTRAINT "ConversationMention_mentionedByUserId_fkey" FOREIGN KEY ("mentionedByUserId") REFERENCES "RbacUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
