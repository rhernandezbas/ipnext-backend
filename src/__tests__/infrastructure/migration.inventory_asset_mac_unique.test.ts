/**
 * Migration SQL-text snapshot test for inventory_asset_mac_unique (FIX 3 depot-stock-entry).
 * Verifies the partial unique index on InventoryAsset.mac (WHERE mac IS NOT NULL) exists
 * and is idempotent (IF NOT EXISTS).
 *
 * Pattern mirrors migration.iclass_returns.test.ts — guards against an accidental
 * `prisma migrate` rewrite that would replace the partial index with a full unique
 * (which would collide on NULLs and break MAC-unknown entries).
 *
 * NAME RULE: dir name must NOT contain substrings pinned by other snapshot tests:
 *   - 'iclass_returns' (migration.iclass_returns.test.ts uses endsWith)
 *   - 'network_node_task' (migration.network_node_task.test.ts uses endsWith)
 *   - 'inventory_foundation' (migration.inventory_foundation.test.ts uses direct path)
 * 'inventory_asset_mac_unique' is safe — it does not match any of those substrings.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('Migration: inventory_asset_mac_unique', () => {
  let migrationSql: string;

  beforeAll(() => {
    const migrationsDir = path.resolve(__dirname, '../../../prisma/migrations');
    const dirs = fs.readdirSync(migrationsDir).filter(d => d.endsWith('_inventory_asset_mac_unique'));
    expect(dirs.length).toBe(1);
    const migrationFile = path.join(migrationsDir, dirs[0], 'migration.sql');
    expect(fs.existsSync(migrationFile)).toBe(true);
    migrationSql = fs.readFileSync(migrationFile, 'utf-8');
  });

  it('creates the mac PARTIAL UNIQUE index (WHERE mac IS NOT NULL)', () => {
    expect(migrationSql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "InventoryAsset_mac_key"[\s\S]*?ON "InventoryAsset"\("mac"\)[\s\S]*?WHERE "mac" IS NOT NULL/i,
    );
  });

  it('is idempotent — uses IF NOT EXISTS', () => {
    expect(migrationSql).toMatch(/IF NOT EXISTS/i);
  });

  it('targets InventoryAsset table, mac column', () => {
    expect(migrationSql).toMatch(/"InventoryAsset"/);
    expect(migrationSql).toMatch(/"mac"/);
  });
});
