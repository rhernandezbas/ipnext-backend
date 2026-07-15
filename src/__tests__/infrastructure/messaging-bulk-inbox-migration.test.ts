/**
 * messaging-bulk-inbox-migration.test.ts (F1/F2, T1) — assertion estática (molde
 * messaging-bulk-migration.test.ts). Pinea la migración
 * 20260909000000_bulk_inbox_projection: aditiva (ADD COLUMN + DROP NOT NULL +
 * CREATE INDEX + FKs SetNull) + backfill best-effort de contactPhoneE164 (E164
 * canónico, NO normalizePhone lossy) SIN guard/RAISE EXCEPTION, sin BEGIN/COMMIT.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Migración 20260909000000_bulk_inbox_projection (T1)', () => {
  let sql: string;

  beforeAll(() => {
    sql = readFileSync(
      join(__dirname, '..', '..', '..', 'prisma', 'migrations', '20260909000000_bulk_inbox_projection', 'migration.sql'),
      'utf8',
    );
  });

  it('Conversation: agrega origin (default chatwoot) + contactPhoneE164 y nulifica chatwootConversationId (DROP NOT NULL, widening)', () => {
    expect(sql).toMatch(/ALTER TABLE "Conversation" ADD COLUMN\s+"contactPhoneE164" TEXT/);
    expect(sql).toMatch(/ADD COLUMN\s+"origin" TEXT NOT NULL DEFAULT 'chatwoot'/);
    expect(sql).toMatch(/ALTER TABLE "Conversation"[\s\S]*ALTER COLUMN "chatwootConversationId" DROP NOT NULL/);
  });

  it('ChatMessage: agrega origin + campaignRecipientId y nulifica chatwootMessageId (DROP NOT NULL)', () => {
    expect(sql).toMatch(/ALTER TABLE "ChatMessage" ADD COLUMN\s+"campaignRecipientId" TEXT/);
    expect(sql).toMatch(/ALTER TABLE "ChatMessage"[\s\S]*ALTER COLUMN "chatwootMessageId" DROP NOT NULL/);
  });

  it('Campaign.templateBody + CampaignRecipient.conversationId como columnas aditivas nullable', () => {
    expect(sql).toMatch(/ALTER TABLE "Campaign" ADD COLUMN\s+"templateBody" TEXT;/);
    expect(sql).toMatch(/ALTER TABLE "CampaignRecipient" ADD COLUMN\s+"conversationId" TEXT;/);
  });

  it('índices: contactPhoneE164 + campaignRecipientId (UNIQUE) + conversationId', () => {
    expect(sql).toMatch(/CREATE INDEX "Conversation_contactPhoneE164_idx" ON "Conversation"\("contactPhoneE164"\)/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "ChatMessage_campaignRecipientId_key" ON "ChatMessage"\("campaignRecipientId"\)/);
    expect(sql).toMatch(/CREATE INDEX "CampaignRecipient_conversationId_idx" ON "CampaignRecipient"\("conversationId"\)/);
  });

  it('FKs con ON DELETE SET NULL (preservan el rastro/lazo al borrar la contraparte)', () => {
    expect(sql).toMatch(
      /ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_campaignRecipientId_fkey" FOREIGN KEY \("campaignRecipientId"\) REFERENCES "CampaignRecipient"\("id"\) ON DELETE SET NULL/,
    );
    expect(sql).toMatch(
      /ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_conversationId_fkey" FOREIGN KEY \("conversationId"\) REFERENCES "Conversation"\("id"\) ON DELETE SET NULL/,
    );
  });

  it('backfill best-effort de contactPhoneE164 (E164 canónico: prefija +549), SIN guard/RAISE EXCEPTION', () => {
    expect(sql).toMatch(/UPDATE "Conversation"[\s\S]*SET "contactPhoneE164"/);
    // E164 canónico (toWhatsAppE164), NO normalizePhone: el backfill construye '+549' || NSN.
    expect(sql).toMatch(/'\+549'\s*\|\|/);
    expect(sql).not.toMatch(/RAISE EXCEPTION/i);
  });

  it('sin BEGIN/COMMIT explícito (Prisma envuelve cada migración en su propia transacción)', () => {
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/m);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/m);
  });
});
