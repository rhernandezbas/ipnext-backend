/**
 * Migration SQL-text snapshot test for uispdevice_ap_link (MIG-1).
 * Verifies the migration adds UispDevice.apUispDeviceId additively — no DROP, no backfill.
 * Pattern mirrors migration.networksite_uisp_link.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('Migration: uispdevice_ap_link', () => {
  let migrationSql: string;

  beforeAll(() => {
    const migrationsDir = path.resolve(__dirname, '../../../prisma/migrations');
    const dirs = fs.readdirSync(migrationsDir).filter(d => d.endsWith('_uispdevice_ap_link'));
    expect(dirs.length).toBe(1);
    const migrationFile = path.join(migrationsDir, dirs[0], 'migration.sql');
    expect(fs.existsSync(migrationFile)).toBe(true);
    migrationSql = fs.readFileSync(migrationFile, 'utf-8');
  });

  it('adds apUispDeviceId column to UispDevice', () => {
    expect(migrationSql).toMatch(/ALTER TABLE "UispDevice"/);
    expect(migrationSql).toMatch(/ADD COLUMN\s+"apUispDeviceId" TEXT/);
  });

  it('has NO destructive statements (DROP) and NO backfill (UPDATE)', () => {
    expect(migrationSql).not.toMatch(/DROP/i);
    expect(migrationSql).not.toMatch(/UPDATE\s+"UispDevice"/i);
  });

  it('has NO explicit transaction wrapper (Prisma wraps each migration itself)', () => {
    expect(migrationSql).not.toMatch(/BEGIN;/);
    expect(migrationSql).not.toMatch(/COMMIT;/);
  });
});
