/**
 * Migration SQL-text snapshot test for 20260911000000_internal_news (review fix L7,
 * spec NEWS-MIG-1 — "MUST NO contener DROP ni backfill" + "seed idempotente ... ON
 * CONFLICT DO NOTHING"). Molde `migration.project_retirement_flag.test.ts`.
 *
 * This is a cheap regression pin (no code under test to fix — the migration file
 * already satisfies the contract), added so sdd-verify has an executable scenario
 * for NEWS-MIG-1 instead of relying on manual review.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('Migration: 20260911000000_internal_news (NEWS-MIG-1)', () => {
  let migrationSql: string;

  beforeAll(() => {
    const migrationFile = path.resolve(
      __dirname,
      '../../../prisma/migrations/20260911000000_internal_news/migration.sql',
    );
    expect(fs.existsSync(migrationFile)).toBe(true);
    migrationSql = fs.readFileSync(migrationFile, 'utf-8');
  });

  it('does NOT contain any destructive DROP statement', () => {
    expect(migrationSql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT)\b/i);
  });

  it('does NOT contain a destructive ALTER — only additive AddForeignKey blocks', () => {
    const alterLines = migrationSql.match(/^ALTER TABLE.*$/gim) ?? [];
    expect(alterLines.length).toBeGreaterThan(0);
    for (const line of alterLines) {
      expect(line).toMatch(/ADD CONSTRAINT/i);
    }
  });

  it('every seed INSERT is idempotent (ON CONFLICT present in the same statement)', () => {
    const insertBlocks = migrationSql
      .split(/(?=INSERT INTO)/i)
      .filter((block) => /^INSERT INTO/i.test(block.trim()));
    expect(insertBlocks.length).toBeGreaterThan(0);
    for (const block of insertBlocks) {
      const statement = block.slice(0, block.indexOf(';') + 1);
      expect(statement).toMatch(/ON CONFLICT/i);
    }
  });

  it('does NOT contain BEGIN or COMMIT (Prisma wraps in its own transaction)', () => {
    expect(migrationSql).not.toMatch(/^\s*BEGIN\s*;/im);
    expect(migrationSql).not.toMatch(/^\s*COMMIT\s*;/im);
  });
});
