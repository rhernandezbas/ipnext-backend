/**
 * Migration SQL-text snapshot test for uisp_site_address.
 * Verifies the migration adds the address column to UispSite idempotently.
 *
 * Pattern mirrors migration.inventory_asset_mac_unique.test.ts.
 *
 * NAME RULE: dir name must NOT contain substrings pinned by other snapshot tests:
 *   - 'iclass_returns'
 *   - 'network_node_task'
 *   - 'inventory_foundation'
 *   - 'inventory_asset_mac_unique'
 *   - 'uisp_mirror'
 *   - 'networksite_uisp_link'
 * 'uisp_site_address' is safe — it does not match any of those substrings.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('Migration: uisp_site_address', () => {
  let migrationSql: string;

  beforeAll(() => {
    const migrationsDir = path.resolve(__dirname, '../../../prisma/migrations');
    const dirs = fs.readdirSync(migrationsDir).filter(d => d.endsWith('_uisp_site_address'));
    expect(dirs.length).toBe(1);
    const migrationFile = path.join(migrationsDir, dirs[0], 'migration.sql');
    expect(fs.existsSync(migrationFile)).toBe(true);
    migrationSql = fs.readFileSync(migrationFile, 'utf-8');
  });

  it('targets UispSite table with ALTER TABLE', () => {
    expect(migrationSql).toMatch(/ALTER TABLE "UispSite"/);
  });

  it('adds address column as TEXT nullable with IF NOT EXISTS (idempotent)', () => {
    expect(migrationSql).toMatch(/ADD COLUMN IF NOT EXISTS "address" TEXT/);
  });

  it('has NO BEGIN/COMMIT wrappers (per migration incident rule)', () => {
    expect(migrationSql).not.toMatch(/^\s*BEGIN\s*;/im);
    expect(migrationSql).not.toMatch(/^\s*COMMIT\s*;/im);
  });
});
