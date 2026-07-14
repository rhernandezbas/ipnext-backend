/**
 * messaging-bulk-migration.test.ts — assertion estática (molde messaging-migration.test.ts).
 * Anti-"deuda silenciosa": pinea rbac.ts (KNOWN_ACTIONS 'bulk'/'templates') + las 2
 * migraciones de Batch 1 (schema Campaign/CampaignRecipient + permisos RBAC bulk/templates).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe("rbac.ts — KNOWN_ACTIONS declara 'bulk' y 'templates' (messaging-bulk F2, T1.4)", () => {
  let rbacSrc: string;

  beforeAll(() => {
    rbacSrc = readFileSync(join(__dirname, '..', '..', 'domain', 'entities', 'rbac.ts'), 'utf8');
  });

  it("KNOWN_ACTIONS declara 'bulk'", () => {
    expect(rbacSrc).toMatch(/'bulk',/);
  });

  it("KNOWN_ACTIONS declara 'templates'", () => {
    expect(rbacSrc).toMatch(/'templates',/);
  });
});

describe('Migración 20260908000000_messaging_bulk_campaigns (T1.2: schema Campaign/CampaignRecipient)', () => {
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
        '20260908000000_messaging_bulk_campaigns',
        'migration.sql',
      ),
      'utf8',
    );
  });

  it('crea los 2 enums nuevos', () => {
    expect(sql).toMatch(/CREATE TYPE "CampaignStatus" AS ENUM/);
    expect(sql).toMatch(/CREATE TYPE "CampaignRecipientStatus" AS ENUM/);
  });

  it('crea las tablas Campaign y CampaignRecipient', () => {
    expect(sql).toMatch(/CREATE TABLE "Campaign" \(/);
    expect(sql).toMatch(/CREATE TABLE "CampaignRecipient" \(/);
  });

  it('agrega Client.whatsappOptOutAt como columna ADITIVA nullable (sin backfill)', () => {
    expect(sql).toMatch(/ALTER TABLE "Client" ADD COLUMN\s+"whatsappOptOutAt" TIMESTAMP\(3\);/);
  });

  it('CampaignRecipient tiene el @@unique compuesto [campaignId, clientId]', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "CampaignRecipient_campaignId_clientId_key" ON "CampaignRecipient"\("campaignId", "clientId"\)/,
    );
  });

  it('crea los 2 índices declarados en design §1.1/§1.2 (Campaign.status + CampaignRecipient[campaignId,status])', () => {
    expect(sql).toMatch(/CREATE INDEX "Campaign_status_idx" ON "Campaign"\("status"\)/);
    expect(sql).toMatch(
      /CREATE INDEX "CampaignRecipient_campaignId_status_idx" ON "CampaignRecipient"\("campaignId", "status"\)/,
    );
  });

  it('Campaign.createdAt tiene índice DESC (historial ListCampaigns)', () => {
    expect(sql).toMatch(/CREATE INDEX "Campaign_createdAt_idx" ON "Campaign"\("createdAt" DESC\)/);
  });

  it('Campaign.createdById es FK a RbacUser con ON DELETE RESTRICT', () => {
    expect(sql).toMatch(
      /ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_createdById_fkey" FOREIGN KEY \("createdById"\) REFERENCES "RbacUser"\("id"\) ON DELETE RESTRICT ON UPDATE CASCADE/,
    );
  });

  it('sin BEGIN/COMMIT explícito (Prisma envuelve cada migración en su propia transacción)', () => {
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/m);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/m);
  });
});

describe('Migración 20260908000100_messaging_bulk_permissions (T1.3: RBAC bulk/templates idempotente)', () => {
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
        '20260908000100_messaging_bulk_permissions',
        'migration.sql',
      ),
      'utf8',
    );
  });

  it("seedea los permisos 'bulk' y 'templates'", () => {
    expect(sql).toMatch(/'bulk'/);
    expect(sql).toMatch(/'templates'/);
  });

  it('grants a super_admin Y administrador', () => {
    expect(sql).toMatch(/'super_admin'/);
    expect(sql).toMatch(/'administrador'/);
  });

  it('TODOS los INSERT son idempotentes: 7 INSERT (módulo + 2 permisos + 4 grants), cada uno con ON CONFLICT DO NOTHING', () => {
    const inserts = sql.match(/INSERT INTO/g) ?? [];
    const conflicts = sql.match(/ON CONFLICT[^;]*DO NOTHING/g) ?? [];
    expect(inserts).toHaveLength(7);
    expect(conflicts).toHaveLength(inserts.length);
  });

  it('sin BEGIN/COMMIT explícito (Prisma envuelve cada migración en su propia transacción)', () => {
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/m);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/m);
  });
});
