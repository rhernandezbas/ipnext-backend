/**
 * Migration SQL-text snapshot test for project_retirement_flag.
 * Verifies allowsEquipmentRetirement BOOLEAN NOT NULL DEFAULT false
 * is added to Project in an idempotent (IF NOT EXISTS) way.
 *
 * NAME RULE: dir name must NOT contain substrings pinned by other snapshot tests:
 *   - 'iclass_returns', 'network_node_task', 'inventory_foundation',
 *     'inventory_asset_mac_unique', 'uisp_mirror', 'networksite_uisp_link'
 * 'project_retirement_flag' is safe.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('Migration: project_retirement_flag', () => {
  let migrationSql: string;

  beforeAll(() => {
    const migrationsDir = path.resolve(__dirname, '../../../prisma/migrations');
    const dirs = fs.readdirSync(migrationsDir).filter(d => d.endsWith('_project_retirement_flag'));
    expect(dirs.length).toBe(1);
    const migrationFile = path.join(migrationsDir, dirs[0], 'migration.sql');
    expect(fs.existsSync(migrationFile)).toBe(true);
    migrationSql = fs.readFileSync(migrationFile, 'utf-8');
  });

  it('adds allowsEquipmentRetirement column to Project as BOOLEAN NOT NULL DEFAULT false', () => {
    expect(migrationSql).toMatch(/ALTER TABLE "Project"/);
    expect(migrationSql).toMatch(/"allowsEquipmentRetirement" BOOLEAN NOT NULL DEFAULT false/);
  });

  it('FIX-6b: ADD COLUMN uses IF NOT EXISTS (idempotent re-run)', () => {
    // Pinning IF NOT EXISTS ensures the migration is safe to re-run (e.g. after a
    // partial apply) without crashing on "column already exists".
    expect(migrationSql).toMatch(/ADD COLUMN IF NOT EXISTS/i);
  });

  it('does NOT contain updatedAt DEFAULT (paridad exacta — Prisma auto-manages updatedAt)', () => {
    expect(migrationSql).not.toMatch(/"updatedAt" .* DEFAULT /);
  });

  it('does NOT contain BEGIN or COMMIT (Prisma wraps in its own transaction)', () => {
    expect(migrationSql).not.toMatch(/^\s*BEGIN\s*;/im);
    expect(migrationSql).not.toMatch(/^\s*COMMIT\s*;/im);
  });
});
