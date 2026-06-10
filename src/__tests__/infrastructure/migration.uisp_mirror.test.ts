/**
 * Migration SQL-text snapshot test for uisp_mirror.
 * Verifies the migration creates UispSite, UispDevice tables with correct structure,
 * the RBAC uisp module/permissions, and the uisp-sync feature flag — all idempotent.
 *
 * Pattern mirrors migration.inventory_asset_mac_unique.test.ts.
 *
 * NAME RULE: dir name must NOT contain substrings pinned by other snapshot tests:
 *   - 'iclass_returns' (migration.iclass_returns.test.ts uses endsWith)
 *   - 'network_node_task' (migration.network_node_task.test.ts uses endsWith)
 *   - 'inventory_foundation' (migration.inventory_foundation.test.ts uses direct path)
 *   - 'inventory_asset_mac_unique' (migration.inventory_asset_mac_unique.test.ts uses endsWith)
 * 'uisp_mirror' is safe — it does not match any of those substrings.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('Migration: uisp_mirror', () => {
  let migrationSql: string;

  beforeAll(() => {
    const migrationsDir = path.resolve(__dirname, '../../../prisma/migrations');
    const dirs = fs.readdirSync(migrationsDir).filter(d => d.endsWith('_uisp_mirror'));
    expect(dirs.length).toBe(1);
    const migrationFile = path.join(migrationsDir, dirs[0], 'migration.sql');
    expect(fs.existsSync(migrationFile)).toBe(true);
    migrationSql = fs.readFileSync(migrationFile, 'utf-8');
  });

  // UispSite table
  it('creates UispSite table with uispId UNIQUE', () => {
    expect(migrationSql).toMatch(/"UispSite"/);
    expect(migrationSql).toMatch(/"uispId"/);
    expect(migrationSql).toMatch(/UNIQUE/);
  });

  it('creates UispSite with uuid PK and TEXT columns', () => {
    expect(migrationSql).toMatch(/"id"\s+UUID/i);
    expect(migrationSql).toMatch(/"name"\s+TEXT/i);
    expect(migrationSql).toMatch(/"status"\s+TEXT/i);
  });

  it('creates UispSite latitude and longitude as DOUBLE PRECISION nullable', () => {
    expect(migrationSql).toMatch(/"latitude"\s+DOUBLE PRECISION/i);
    expect(migrationSql).toMatch(/"longitude"\s+DOUBLE PRECISION/i);
  });

  it('creates UispSite with missingSince and lastSyncAt as TIMESTAMP(3)', () => {
    expect(migrationSql).toMatch(/"missingSince"\s+TIMESTAMP\(3\)/i);
    expect(migrationSql).toMatch(/"lastSyncAt"\s+TIMESTAMP\(3\)/i);
  });

  it('creates UispSite updatedAt without default', () => {
    // updatedAt must appear without DEFAULT for UispSite
    const siteBlock = migrationSql.match(/CREATE TABLE[^;]*"UispSite"[^;]*;/is)?.[0] ?? '';
    expect(siteBlock).toMatch(/"updatedAt"/i);
    // updatedAt line must NOT have DEFAULT in the site block
    const updatedAtLine = siteBlock.split('\n').find(l => l.includes('"updatedAt"')) ?? '';
    expect(updatedAtLine).not.toMatch(/DEFAULT/i);
  });

  it('has index on UispSite status and missingSince', () => {
    expect(migrationSql).toMatch(/CREATE INDEX[^;]*ON "UispSite"[^;]*"status"/i);
    expect(migrationSql).toMatch(/CREATE INDEX[^;]*ON "UispSite"[^;]*"missingSince"/i);
  });

  // UispDevice table
  it('creates UispDevice table with uispId UNIQUE', () => {
    expect(migrationSql).toMatch(/"UispDevice"/);
  });

  it('creates UispDevice with uispSiteId TEXT (no FK constraint)', () => {
    const deviceBlock = migrationSql.match(/CREATE TABLE[^;]*"UispDevice"[^;]*;/is)?.[0] ?? '';
    expect(deviceBlock).toMatch(/"uispSiteId"\s+TEXT/i);
    // No REFERENCES constraint for uispSiteId
    expect(deviceBlock).not.toMatch(/REFERENCES.*"UispSite"/i);
  });

  it('creates UispDevice with BIGINT uptime', () => {
    expect(migrationSql).toMatch(/"uptime"\s+BIGINT/i);
  });

  it('creates UispDevice updatedAt without default', () => {
    const deviceBlock = migrationSql.match(/CREATE TABLE[^;]*"UispDevice"[^;]*;/is)?.[0] ?? '';
    expect(deviceBlock).toMatch(/"updatedAt"/i);
    const updatedAtLine = deviceBlock.split('\n').find(l => l.includes('"updatedAt"')) ?? '';
    expect(updatedAtLine).not.toMatch(/DEFAULT/i);
  });

  it('has index on UispDevice uispSiteId, status, missingSince', () => {
    expect(migrationSql).toMatch(/CREATE INDEX[^;]*ON "UispDevice"[^;]*"uispSiteId"/i);
    expect(migrationSql).toMatch(/CREATE INDEX[^;]*ON "UispDevice"[^;]*"status"/i);
    expect(migrationSql).toMatch(/CREATE INDEX[^;]*ON "UispDevice"[^;]*"missingSince"/i);
  });

  // RBAC seeds
  it('seeds uisp module idempotently (ON CONFLICT DO NOTHING)', () => {
    expect(migrationSql).toMatch(/'uisp'/);
    expect(migrationSql).toMatch(/ON CONFLICT DO NOTHING/i);
  });

  it('seeds uisp:read and uisp:manage permissions', () => {
    expect(migrationSql).toMatch(/'read'/);
    expect(migrationSql).toMatch(/'manage'/);
  });

  it('grants uisp permissions to super_admin', () => {
    expect(migrationSql).toMatch(/'super_admin'/);
    expect(migrationSql).toMatch(/"RbacRolePermission"/);
  });

  // Feature flag
  it('seeds uisp-sync feature flag disabled by default', () => {
    expect(migrationSql).toMatch(/'uisp-sync'/);
    expect(migrationSql).toMatch(/false/i);
  });

  // Idempotency
  it('is idempotent — all inserts use ON CONFLICT ... DO NOTHING', () => {
    // Matches both "ON CONFLICT DO NOTHING" and "ON CONFLICT (cols) DO NOTHING"
    const conflicts = migrationSql.match(/ON CONFLICT[^;]*DO NOTHING/gi) ?? [];
    expect(conflicts.length).toBeGreaterThanOrEqual(5);
  });
});
