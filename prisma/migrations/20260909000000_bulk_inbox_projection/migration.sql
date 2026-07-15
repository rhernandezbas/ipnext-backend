-- Migration: 20260909000000_bulk_inbox_projection
-- messaging-bulk-inbox (F1+F2): el bulk deja rastro en el inbox + etiqueta por campaña.
-- ADITIVA y de bajo riesgo: ADD COLUMN + DROP NOT NULL (widening, no destructivo, el
-- índice único se conserva porque PG trata NULLs como distintos) + CREATE INDEX + FKs.
-- Generado con: npx prisma migrate diff --from-schema <HEAD:schema> --to-schema
--               prisma/schema.prisma --script, + backfill best-effort agregado a mano.
-- No explicit transaction block (Prisma wraps each migration in its own transaction).

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "contactPhoneE164" TEXT,
ADD COLUMN     "origin" TEXT NOT NULL DEFAULT 'chatwoot',
ALTER COLUMN "chatwootConversationId" DROP NOT NULL;

-- Backfill best-effort de Conversation.contactPhoneE164 replicando toWhatsAppE164
-- (NO normalizePhone, que es LOSSY con el "15" embebido → duplicados cross-format).
-- Pasos: 1) strip no-dígitos; 2) drop prefijo internacional '00'; 3) drop country-code
-- '54' (+ marcador móvil '9') SOLO si len>10; 4) drop troncal '0'; 5) extraer NSN de 10
-- dígitos (manejando el '15' móvil embebido según el largo de área 2/3/4, con "11" para
-- área de 2); 6) resultado = '+549' || NSN, o NULL si no se reconstruye ("no matcheable
-- aún", degradación segura — Fase 2 reconcilia al responder el cliente). SIN guard que
-- aborte. Set-based, idempotente.
UPDATE "Conversation" AS c
SET "contactPhoneE164" = t.e164
FROM (
  SELECT id, CASE WHEN nsn IS NULL THEN NULL ELSE '+549' || nsn END AS e164
  FROM (
    SELECT id,
      CASE
        WHEN length(s4) = 10 THEN s4
        WHEN length(s4) = 11 AND left(s4, 1) = '9' THEN substring(s4 FROM 2)
        WHEN x12 IS NOT NULL AND substring(x12 FROM 3 FOR 2) = '15' AND left(x12, 2) = '11' THEN left(x12, 2) || substring(x12 FROM 5)
        WHEN x12 IS NOT NULL AND substring(x12 FROM 4 FOR 2) = '15' THEN left(x12, 3) || substring(x12 FROM 6)
        WHEN x12 IS NOT NULL AND substring(x12 FROM 5 FOR 2) = '15' THEN left(x12, 4) || substring(x12 FROM 7)
        ELSE NULL
      END AS nsn
    FROM (
      SELECT id, s4,
        CASE
          WHEN length(s4) = 12 THEN s4
          WHEN length(s4) = 13 AND left(s4, 1) = '9' THEN substring(s4 FROM 2)
          ELSE NULL
        END AS x12
      FROM (
        SELECT id, regexp_replace(s3, '^0+', '') AS s4
        FROM (
          SELECT id, CASE WHEN cs AND left(s2, 1) = '9' THEN substring(s2 FROM 2) ELSE s2 END AS s3
          FROM (
            SELECT id, cs, CASE WHEN cs THEN substring(s1 FROM 3) ELSE s1 END AS s2
            FROM (
              SELECT id, s1, (left(s1, 2) = '54' AND length(s1) > 10) AS cs
              FROM (
                SELECT id, CASE WHEN left(s0, 2) = '00' THEN substring(s0 FROM 3) ELSE s0 END AS s1
                FROM (
                  SELECT id, regexp_replace(coalesce("contactPhone", ''), '[^0-9]', '', 'g') AS s0
                  FROM "Conversation"
                  WHERE "contactPhone" IS NOT NULL
                ) a
              ) b
            ) d
          ) e
        ) f
      ) g
    ) h
  ) i
) AS t
WHERE c.id = t.id;

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "campaignRecipientId" TEXT,
ADD COLUMN     "origin" TEXT NOT NULL DEFAULT 'chatwoot',
ALTER COLUMN "chatwootMessageId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "templateBody" TEXT;

-- AlterTable
ALTER TABLE "CampaignRecipient" ADD COLUMN     "conversationId" TEXT;

-- CreateIndex
CREATE INDEX "Conversation_contactPhoneE164_idx" ON "Conversation"("contactPhoneE164");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_campaignRecipientId_key" ON "ChatMessage"("campaignRecipientId");

-- CreateIndex
CREATE INDEX "CampaignRecipient_conversationId_idx" ON "CampaignRecipient"("conversationId");

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_campaignRecipientId_fkey" FOREIGN KEY ("campaignRecipientId") REFERENCES "CampaignRecipient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
