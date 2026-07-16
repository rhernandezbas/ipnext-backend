/**
 * bulk-csv-recipients (PER-1, B3.1) — assertion estática (molde
 * messaging-bulk-inbox-migration.test.ts). Pinea la migración
 * 20260920000000_campaign_recipient_contact_rows: puramente ADITIVA (ADD COLUMN
 * "contactName" + DROP NOT NULL sobre "clientId"), SIN backfill, sin rewrite,
 * sin BEGIN/COMMIT explícito, `generada con prisma migrate diff` (offline, sin
 * DB — el ambiente de este batch no tiene credenciales válidas contra el
 * Postgres local, ver reporte del batch).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Migración 20260920000000_campaign_recipient_contact_rows (PER-1)', () => {
  let sql: string;

  beforeAll(() => {
    sql = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        '..',
        'prisma',
        'migrations',
        '20260920000000_campaign_recipient_contact_rows',
        'migration.sql',
      ),
      'utf8',
    );
  });

  it('agrega CampaignRecipient.contactName como columna ADITIVA nullable', () => {
    expect(sql).toMatch(/ALTER TABLE "CampaignRecipient" ADD COLUMN\s+"contactName" TEXT/);
  });

  it('CampaignRecipient.clientId pasa a nullable (DROP NOT NULL) — sin rewrite ni backfill', () => {
    expect(sql).toMatch(/ALTER TABLE "CampaignRecipient"[\s\S]*ALTER COLUMN "clientId" DROP NOT NULL/);
  });

  it('NO toca el @@unique[campaignId, clientId] existente (se conserva tal cual, D1)', () => {
    expect(sql).not.toMatch(/DROP (INDEX|CONSTRAINT).*campaignId_clientId/i);
    expect(sql).not.toMatch(/CREATE UNIQUE INDEX.*campaignId_clientId/i);
  });

  it('sin backfill ni RAISE EXCEPTION (puramente aditiva, D1)', () => {
    expect(sql).not.toMatch(/UPDATE\s+"CampaignRecipient"/i);
    expect(sql).not.toMatch(/RAISE EXCEPTION/i);
  });

  it('sin BEGIN/COMMIT explícito (Prisma envuelve cada migración en su propia transacción)', () => {
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/m);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/m);
  });
});
