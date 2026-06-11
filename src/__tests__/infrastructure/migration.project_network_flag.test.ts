/**
 * Migration SQL-text snapshot test for project_network_flag (#40).
 * Verifies isNetworkProject BOOLEAN NOT NULL DEFAULT false
 * is added to Project in an idempotent (IF NOT EXISTS) way.
 *
 * Mirrors migration.project_retirement_flag.test.ts.
 *
 * NAME RULE: dir name must NOT contain substrings pinned by other snapshot tests.
 * 'project_network_flag' is safe.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('Migration: project_network_flag', () => {
  let migrationSql: string;

  beforeAll(() => {
    const migrationsDir = path.resolve(__dirname, '../../../prisma/migrations');
    const dirs = fs.readdirSync(migrationsDir).filter(d => d.endsWith('_project_network_flag'));
    expect(dirs.length).toBe(1);
    const migrationFile = path.join(migrationsDir, dirs[0], 'migration.sql');
    expect(fs.existsSync(migrationFile)).toBe(true);
    migrationSql = fs.readFileSync(migrationFile, 'utf-8');
  });

  it('adds isNetworkProject column to Project as BOOLEAN NOT NULL DEFAULT false', () => {
    expect(migrationSql).toMatch(/ALTER TABLE "Project"/);
    expect(migrationSql).toMatch(/"isNetworkProject" BOOLEAN NOT NULL DEFAULT false/);
  });

  it('ADD COLUMN uses IF NOT EXISTS (idempotent re-run)', () => {
    expect(migrationSql).toMatch(/ADD COLUMN IF NOT EXISTS/i);
  });

  it('does NOT contain updatedAt DEFAULT (Prisma auto-manages updatedAt)', () => {
    expect(migrationSql).not.toMatch(/"updatedAt" .* DEFAULT /);
  });

  it('does NOT contain BEGIN or COMMIT (Prisma wraps in its own transaction)', () => {
    expect(migrationSql).not.toMatch(/^\s*BEGIN\s*;/im);
    expect(migrationSql).not.toMatch(/^\s*COMMIT\s*;/im);
  });
});
