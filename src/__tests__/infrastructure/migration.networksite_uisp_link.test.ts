/**
 * Migration SQL-text snapshot test for networksite_uisp_link.
 * Verifies the migration adds the uispSiteId column and index to NetworkSite
 * in an idempotent (IF NOT EXISTS) way.
 *
 * NAME RULE: dir name must NOT contain substrings pinned by other snapshot tests:
 *   - 'iclass_returns'
 *   - 'network_node_task'
 *   - 'inventory_foundation'
 *   - 'inventory_asset_mac_unique'
 *   - 'uisp_mirror'
 * 'networksite_uisp_link' is safe.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('Migration: networksite_uisp_link', () => {
  let migrationSql: string;

  beforeAll(() => {
    const migrationsDir = path.resolve(__dirname, '../../../prisma/migrations');
    const dirs = fs.readdirSync(migrationsDir).filter(d => d.endsWith('_networksite_uisp_link'));
    expect(dirs.length).toBe(1);
    const migrationFile = path.join(migrationsDir, dirs[0], 'migration.sql');
    expect(fs.existsSync(migrationFile)).toBe(true);
    migrationSql = fs.readFileSync(migrationFile, 'utf-8');
  });

  it('adds uispSiteId column to NetworkSite with IF NOT EXISTS (idempotent)', () => {
    expect(migrationSql).toMatch(/ALTER TABLE "NetworkSite"/);
    expect(migrationSql).toMatch(/ADD COLUMN IF NOT EXISTS "uispSiteId" TEXT/);
  });

  it('creates an index on uispSiteId with IF NOT EXISTS (idempotent)', () => {
    expect(migrationSql).toMatch(/CREATE INDEX IF NOT EXISTS/);
    expect(migrationSql).toMatch(/"NetworkSite_uispSiteId_idx"/);
    expect(migrationSql).toMatch(/ON "NetworkSite" \("uispSiteId"\)/);
  });

  it('has NO FK constraint to UispSite (validation is at application layer)', () => {
    expect(migrationSql).not.toMatch(/REFERENCES "UispSite"/);
    expect(migrationSql).not.toMatch(/FOREIGN KEY/);
  });
});
