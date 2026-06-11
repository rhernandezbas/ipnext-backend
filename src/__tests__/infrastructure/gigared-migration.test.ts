/**
 * #47 — static snapshot guard for the gigared_tv migration.
 * Booting a real DB is out of scope here; we assert the SQL contains the additive,
 * idempotent pieces required by the spec (no BEGIN/COMMIT; table + RBAC + grants + flag).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('20260630000000_gigared_tv migration (#47)', () => {
  let sql: string;

  beforeAll(() => {
    sql = readFileSync(
      join(__dirname, '..', '..', '..', 'prisma', 'migrations', '20260630000000_gigared_tv', 'migration.sql'),
      'utf8',
    );
  });

  it('is additive — no BEGIN;/COMMIT; statements (Prisma wraps it)', () => {
    // Strip comment lines so a mention in a `-- … no BEGIN/COMMIT …` note never trips the guard.
    const statements = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(statements).not.toMatch(/\bBEGIN\s*;/i);
    expect(statements).not.toMatch(/\bCOMMIT\s*;/i);
  });

  it('creates the GigaredConfig table with singleton id + apiKey/baseUrl defaults', () => {
    expect(sql).toMatch(/CREATE TABLE "GigaredConfig"/);
    expect(sql).toMatch(/"apiKey"\s+TEXT\s+NOT NULL\s+DEFAULT ''/);
    expect(sql).toMatch(/partners\.gigaredsa\.com\.ar\/api\/v1/);
  });

  it("seeds the 'tv' RBAC module + read/write/manage permissions", () => {
    expect(sql).toMatch(/INSERT INTO "RbacModule"[\s\S]*'tv'[\s\S]*'TV \/ Gigared'/);
    expect(sql).toMatch(/'read'/);
    expect(sql).toMatch(/'write'/);
    expect(sql).toMatch(/'manage'/);
  });

  it('grants tv perms to BOTH super_admin and administrador', () => {
    expect(sql).toMatch(/'super_admin'/);
    expect(sql).toMatch(/'administrador'/);
  });

  it("seeds the 'gigared-integration' feature flag as OFF", () => {
    expect(sql).toMatch(/INSERT INTO "FeatureFlag"[\s\S]*'gigared-integration'[\s\S]*false/);
  });

  it('every INSERT is idempotent (ON CONFLICT DO NOTHING)', () => {
    const inserts = sql.match(/INSERT INTO/g) ?? [];
    const conflicts = sql.match(/ON CONFLICT/g) ?? [];
    expect(inserts.length).toBeGreaterThan(0);
    expect(conflicts.length).toBeGreaterThanOrEqual(inserts.length);
  });
});
