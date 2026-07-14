-- Migration: 20260908000000_messaging_bulk_campaigns
-- messaging-bulk (F2): envío masivo por template WhatsApp (Twilio Content directo).
-- Aditiva pura: nuevos enums + nuevas tablas Campaign/CampaignRecipient + columna
-- nullable Client.whatsappOptOutAt (sin backfill, default null = contactable).
-- Generado con: npx prisma migrate diff --from-schema prisma/schema.prisma.bak
--               --to-schema prisma/schema.prisma --script (design §1.4).
-- No explicit transaction block (Prisma wraps each migration in its own transaction).

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('pending', 'running', 'paused', 'done', 'failed');

-- CreateEnum
CREATE TYPE "CampaignRecipientStatus" AS ENUM ('queued', 'sent', 'delivered', 'opted_out', 'skipped', 'failed');

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "whatsappOptOutAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "templateRef" TEXT NOT NULL,
    "templateName" TEXT,
    "segment" JSONB NOT NULL,
    "variableSpec" JSONB NOT NULL DEFAULT '{}',
    "status" "CampaignStatus" NOT NULL DEFAULT 'pending',
    "total" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "optedOutCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignRecipient" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "phoneNormalized" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "status" "CampaignRecipientStatus" NOT NULL DEFAULT 'queued',
    "providerId" TEXT,
    "chatwootConversationId" INTEGER,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Campaign_status_idx" ON "Campaign"("status");

-- CreateIndex
CREATE INDEX "Campaign_createdAt_idx" ON "Campaign"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "CampaignRecipient_campaignId_status_idx" ON "CampaignRecipient"("campaignId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRecipient_campaignId_clientId_key" ON "CampaignRecipient"("campaignId", "clientId");

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "RbacUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
