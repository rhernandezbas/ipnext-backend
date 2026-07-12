-- messaging-inbox (F1: Inbox WhatsApp/Chatwoot): mirror local de conversaciones/mensajes
-- de Chatwoot + tabla de idempotencia de entregas de webhook. Aditiva (3 tablas nuevas +
-- índices) → segura, sin backfill, sin transacción manual. Sin FK a Client (match por
-- teléfono normalizado, no por id, ver design §1).

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "chatwootConversationId" INTEGER NOT NULL,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "canReply" BOOLEAN NOT NULL DEFAULT false,
    "lastMessageAt" TIMESTAMP(3),
    "lastMessagePreview" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "chatwootMessageId" INTEGER NOT NULL,
    "direction" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "senderName" TEXT,
    "chatwootCreatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'chatwoot',
    "deliveryId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_chatwootConversationId_key" ON "Conversation"("chatwootConversationId");

-- CreateIndex
-- §9: DESC NULLS LAST matches the actual INBOX-1 query (orderBy lastMessageAt DESC
-- NULLS LAST in PrismaConversationRepository.list) — the default ASC NULLS LAST
-- index Postgres builds from a plain column reference does NOT serve a DESC scan
-- efficiently and defeats the point of the index for the inbox's most-common query.
CREATE INDEX "Conversation_lastMessageAt_idx" ON "Conversation"("lastMessageAt" DESC NULLS LAST);

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_chatwootMessageId_key" ON "ChatMessage"("chatwootMessageId");

-- CreateIndex
CREATE INDEX "ChatMessage_conversationId_chatwootCreatedAt_idx" ON "ChatMessage"("conversationId", "chatwootCreatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_source_deliveryId_key" ON "WebhookDelivery"("source", "deliveryId");

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
