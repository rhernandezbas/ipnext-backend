/**
 * migration.portal_push_token_preferences.test.ts — assertion estática
 * (molde `ticket-messaging-migration.test.ts`) sobre
 * 20261107000000_portal_push_token_preferences.
 *
 * push-per-device — las preferencias de push se mudan de la CUENTA
 * (`PortalPushPreference`) al TOKEN (`PortalPushToken`). Este test fija que
 * la migración: (1) agrega las 4 columnas nuevas con DEFAULT seguro
 * (serviceAlerts=true, promos=false, mismo valor que el schema ya
 * documentaba a nivel de cuenta), y (2) backfillea, POR CUENTA, la
 * preferencia vieja hacia TODOS los tokens de esa cuenta — nadie pierde su
 * configuración, sea 1 cuenta con 1 token (hoy) o N cuentas con N tokens.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Migración 20261107000000_portal_push_token_preferences', () => {
  let sql: string;

  beforeAll(() => {
    sql = readFileSync(
      join(__dirname, '..', '..', '..', 'prisma', 'migrations', '20261107000000_portal_push_token_preferences', 'migration.sql'),
      'utf8',
    );
  });

  it('serviceAlerts se agrega NOT NULL DEFAULT true (lado transaccional, sin restricción de las stores)', () => {
    expect(sql).toMatch(/ALTER TABLE "PortalPushToken" ADD COLUMN "serviceAlerts" BOOLEAN NOT NULL DEFAULT true;/);
  });

  it('promos se agrega NOT NULL DEFAULT false (el opt-in de marketing es EXPLÍCITO, nunca asumido)', () => {
    expect(sql).toMatch(/ALTER TABLE "PortalPushToken" ADD COLUMN "promos" BOOLEAN NOT NULL DEFAULT false;/);
  });

  it('promosOptInAt/promosOptInAppVersion se agregan NULLABLE, sin DEFAULT (rastro de auditoría, no un toggle)', () => {
    expect(sql).toMatch(/ALTER TABLE "PortalPushToken" ADD COLUMN "promosOptInAt" TIMESTAMP\(3\);/);
    expect(sql).toMatch(/ALTER TABLE "PortalPushToken" ADD COLUMN "promosOptInAppVersion" TEXT;/);
    expect(sql).not.toMatch(/"promosOptInAt"[^;]*DEFAULT/);
    expect(sql).not.toMatch(/"promosOptInAppVersion"[^;]*DEFAULT/);
  });

  it('el backfill copia las 4 columnas de PortalPushPreference hacia PortalPushToken, unido por accountId', () => {
    expect(sql).toMatch(
      /UPDATE "PortalPushToken" t\s+SET "serviceAlerts" = p\."serviceAlerts",\s+"promos" = p\."promos",\s+"promosOptInAt" = p\."promosOptInAt",\s+"promosOptInAppVersion" = p\."promosOptInAppVersion"\s+FROM "PortalPushPreference" p\s+WHERE p\."accountId" = t\."accountId";/,
    );
  });

  it('ningún DROP — PortalPushPreference queda huérfana a propósito, no se borra en este change', () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DROP COLUMN/i);
  });

  it('sin BEGIN/COMMIT explícito (Prisma envuelve cada migración en su propia transacción)', () => {
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/m);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/m);
  });
});
