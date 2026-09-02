-- external-bulk-messaging (D1) — 2 tablas nuevas + 1 columna, todo aditivo.
--
-- ExternalBulkPreview: preview EFÍMERO de un lote externo (validate/send de 2
-- pasos, API M2M). NO es una Campaign: no infla el historial admin ni el cupo
-- diario (D6, contado sobre recipients realmente `sent`). TTL lazy + purga
-- oportunista acotada apoyada en el índice de expiresAt (D9).
--
-- ExternalBulkMessagingConfig: topes editables sin redeploy (maxPerRequest/
-- maxPerDay). Fila única `id='singleton'`, molde EXACTO
-- WhatsappTaskStageTransitionConfig/FinanceReceiptSyncConfig.
--
-- Campaign.externalIdempotencyKey: nullable + @unique (molde
-- ChatMessage.idempotencyKey). Postgres trata cada NULL como distinto, así
-- que las campañas de UI existentes conviven sin backfill. Es el backstop de
-- carrera (P2002) para 2 `send` concurrentes con la MISMA Idempotency-Key
-- que ambos pasaron el guard-0 del use case (D1.a).
--
-- CampaignRecipient.variables: nullable JSONB, sin default (D4.c) — literales
-- POR-RECIPIENT del caller externo, snapshot auditable de lo mandado a ESE
-- destinatario. Aditiva: `null` en toda fila pre-existente y en los dominios
-- que no la usan (segment/manual/csv/task). Persistencia SOLO en B1 — el
-- merge/consumo en el render de SendExternalBulk es B3.
--
-- Generado sin DB con:
--   npx prisma migrate diff --from-schema <schema en HEAD> \
--                            --to-schema prisma/schema.prisma --script
-- (patrón gr-invoices-sync / customer-portal-api). Sin BEGIN/COMMIT — Prisma
-- envuelve cada migración en su propia transacción.
--
-- El prefijo NO es una fecha real: es la secuencia monotónica sintética del
-- repo, posterior a la última migración existente (20261111000000).
-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "externalIdempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "CampaignRecipient" ADD COLUMN     "variables" JSONB;

-- CreateTable
CREATE TABLE "ExternalBulkPreview" (
    "id" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "templateRef" TEXT NOT NULL,
    "templateName" TEXT NOT NULL,
    "variables" JSONB NOT NULL DEFAULT '{}',
    "chatwootLabel" TEXT,
    "recipients" JSONB NOT NULL,
    "invalid" JSONB NOT NULL DEFAULT '[]',
    "validCount" INTEGER NOT NULL,
    "invalidCount" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "campaignId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalBulkPreview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalBulkMessagingConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "maxPerRequest" INTEGER NOT NULL DEFAULT 500,
    "maxPerDay" INTEGER NOT NULL DEFAULT 2000,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalBulkMessagingConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExternalBulkPreview_campaignId_key" ON "ExternalBulkPreview"("campaignId");

-- CreateIndex
CREATE INDEX "ExternalBulkPreview_expiresAt_idx" ON "ExternalBulkPreview"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_externalIdempotencyKey_key" ON "Campaign"("externalIdempotencyKey");

-- CreateIndex
-- fix wave F2 (NEW-2) — respalda `countAuthorizedRecipientsByCreatorSince`
-- (D3.a/D6, cupo diario): filtra `CampaignRecipient` por `createdAt >= since`
-- en CADA `send` externo (SEND-4 paso 7); sin este índice era un full scan.
CREATE INDEX "CampaignRecipient_createdAt_idx" ON "CampaignRecipient"("createdAt");

-- Feature flag: messaging-external-bulk-enabled (default OFF — deploy DARK, D14).
--
-- DEBE nacer de la migración: SetFeatureFlag hace `update`, NO `upsert` — sin
-- esta fila, la card del FE (Batch 5) devuelve 404 para siempre (mismo
-- incidente ya documentado en 20261028000000_iclass_gps_ingest_flag). El
-- kill-switch se prende DESPUÉS, desde la UI (PATCH /api/feature-flags/...),
-- sin deploy nuevo (D14 paso 3).
--
-- Idempotente: ON CONFLICT DO NOTHING sobre el PK `key`.
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('messaging-external-bulk-enabled', false, NOW())
ON CONFLICT DO NOTHING;
